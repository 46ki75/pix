import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Registry } from "./registry.ts";

// Control OS event ordering without depending on macOS's zombie-reaping window.
// No real processes, file descriptors, or directories are created in this suite.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", () => ({
  openSync: vi.fn(() => 42),
  closeSync: vi.fn(),
  writeSync: vi.fn((_fd: number, buffer: Buffer) => buffer.length),
}));
vi.mock("./directory.ts", () => ({ privateDirectory: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(process, "kill").mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function signalError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`kill ${code}`), { code, syscall: "kill" });
}

async function create(timeout?: number) {
  const stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const child = Object.assign(new EventEmitter(), {
    pid: 123456,
    stdout,
    stderr,
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  const registry = new Registry({
    shell: { shell: "/bin/sh", args: ["-c"] },
    outputDir: "/fake/bg",
    maxOutputBytes: 1024,
    graceMs: 100,
  });
  const changed = vi.fn();
  registry.subscribe(changed);
  const starting = registry.start({
    command: "fixture",
    cwd: "/",
    ...(timeout === undefined ? {} : { timeout }),
  });
  child.emit("spawn");
  const task = await starting;
  return {
    registry,
    task,
    stdout,
    stderr,
    changed,
    kill: vi.mocked(process.kill),
    exit: (code: number | null = 0, signal: NodeJS.Signals | null = null) =>
      child.emit("exit", code, signal),
    close: () => child.emit("close"),
  };
}

test("concurrent stops share signaling and preserve the first reason", async () => {
  const h = await create();
  let terminated = false;
  h.kill.mockImplementation((_pid, signal) => {
    if (signal === "SIGTERM") {
      if (terminated) throw signalError("EPERM");
      terminated = true;
    }
    return true;
  });
  const results = Promise.allSettled([
    h.registry.stop(h.task.id, "user"),
    h.registry.stop(h.task.id, "agent"),
  ]);
  expect(h.kill.mock.calls).toEqual([[-h.task.pid, "SIGTERM"]]);
  h.exit(null, "SIGTERM");
  h.close();
  await vi.advanceTimersByTimeAsync(100);
  for (const result of await results) {
    expect(result).toMatchObject({
      status: "fulfilled",
      value: { status: "finished", outcome: { kind: "killed", by: "user" } },
    });
  }
  expect(closeSync).toHaveBeenCalledExactlyOnceWith(42);
  expect(
    h.changed.mock.calls.filter(([task]) => task.status === "finished"),
  ).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("disposal joins pending cleanup without resending SIGTERM", async () => {
  const h = await create();
  const stopped = h.registry.stop(h.task.id, "user");
  h.kill.mockImplementation((_pid, signal) => {
    if (signal === "SIGTERM") throw signalError("EPERM");
    return true;
  });
  const disposing = h.registry.disposeAll();
  expect(h.registry.disposeAll()).toBe(disposing);
  expect(h.kill.mock.calls).toEqual([[-h.task.pid, "SIGTERM"]]);
  h.exit(null, "SIGTERM");
  h.close();
  await vi.advanceTimersByTimeAsync(100);
  await disposing;
  expect((await stopped).outcome).toEqual({ kind: "killed", by: "user" });
  expect(vi.getTimerCount()).toBe(0);
});

test("timeout exit does not signal an already escalated group", async () => {
  const h = await create(0.1);
  await vi.advanceTimersByTimeAsync(200);
  expect(h.kill.mock.calls).toEqual([
    [-h.task.pid, "SIGTERM"],
    [-h.task.pid, "SIGKILL"],
  ]);
  // macOS can still find a zombie-only group after SIGKILL, returning EPERM.
  h.kill.mockImplementation(() => {
    throw signalError("EPERM");
  });
  expect(() => h.exit(null, "SIGKILL")).not.toThrow();
  h.close();
  expect((await h.registry.wait(h.task.id)).outcome).toEqual({
    kind: "timed_out",
  });
  expect(h.kill).toHaveBeenCalledTimes(2);
  expect(closeSync).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["before", "after"] as const)(
  "drains retained pipes when the shell exits %s escalation",
  async (order) => {
    const h = await create();
    const stopped = h.registry.stop(h.task.id, "agent");
    if (order === "before") h.exit(null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    if (order === "after") h.exit(null, "SIGKILL");
    expect(h.registry.get(h.task.id).status).toBe("stopping");
    await vi.advanceTimersByTimeAsync(99);
    expect(h.stdout.destroy).not.toHaveBeenCalled();
    expect(h.stderr.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.stdout.destroy).toHaveBeenCalledOnce();
    expect(h.stderr.destroy).toHaveBeenCalledOnce();
    // Destroying the retained pipes eventually causes Node's close event.
    h.close();
    expect((await stopped).outcome).toEqual({ kind: "killed", by: "agent" });
    expect(closeSync).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("shell exit finishes promptly when the pending group is absent", async () => {
  const h = await create();
  const stopped = h.registry.stop(h.task.id, "user");
  h.kill.mockImplementation((_pid, signal) => {
    if (signal === 0) throw signalError("ESRCH");
    throw signalError("EPERM");
  });
  expect(() => h.exit(null, "SIGTERM")).not.toThrow();
  h.close();
  expect((await stopped).status).toBe("finished");
  expect(h.kill.mock.calls).toEqual([
    [-h.task.pid, "SIGTERM"],
    [-h.task.pid, 0],
  ]);
  // No full grace-period delay for a group already known to be gone.
  expect(vi.getTimerCount()).toBe(0);
  expect(h.stdout.destroy).not.toHaveBeenCalled();
});

test.each(["present", "EPERM"])(
  "an unresolved group probe (%s) preserves escalation after shell exit",
  async (probe) => {
    const h = await create();
    const stopped = h.registry.stop(h.task.id, "agent");
    h.kill.mockImplementation((_pid, signal) => {
      if (signal === 0) {
        if (probe === "EPERM") throw signalError("EPERM");
        return true;
      }
      if (signal === "SIGKILL") return true;
      throw signalError("EPERM");
    });
    expect(() => h.exit(null, "SIGTERM")).not.toThrow();
    h.close();
    expect(h.registry.get(h.task.id).status).toBe("stopping");
    expect(closeSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(99);
    expect(h.kill).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await stopped).status).toBe("finished");
    expect(h.kill.mock.calls).toEqual([
      [-h.task.pid, "SIGTERM"],
      [-h.task.pid, 0],
      [-h.task.pid, "SIGKILL"],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("an initial SIGTERM permission error remains visible and retryable", async () => {
  const h = await create();
  const error = signalError("EPERM");
  h.kill.mockImplementation(() => {
    throw error;
  });
  await expect(h.registry.stop(h.task.id, "user")).rejects.toBe(error);
  expect(h.registry.get(h.task.id).status).toBe("stopping");
  expect(closeSync).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  h.kill.mockReturnValue(true);
  const retried = h.registry.stop(h.task.id, "agent");
  h.kill.mockImplementation(() => {
    throw signalError("ESRCH");
  });
  h.exit(null, "SIGTERM");
  h.close();
  expect((await retried).outcome).toEqual({ kind: "killed", by: "user" });
});

test("a SIGKILL permission error is not reported as successful cleanup", async () => {
  const h = await create();
  void h.registry.stop(h.task.id, "user");
  const error = signalError("EPERM");
  h.kill.mockImplementation(() => {
    throw error;
  });
  expect(() => vi.advanceTimersByTime(100)).toThrow(error);
  expect(h.registry.get(h.task.id).status).toBe("stopping");
  expect(closeSync).not.toHaveBeenCalled();
});

test("unexpected group-probe errors are not suppressed", async () => {
  const h = await create();
  void h.registry.stop(h.task.id, "user");
  const error = signalError("EINVAL");
  h.kill.mockImplementation(() => {
    throw error;
  });
  expect(() => h.exit(null, "SIGTERM")).toThrow(error);
  expect(h.registry.get(h.task.id).status).toBe("stopping");
  expect(closeSync).not.toHaveBeenCalled();
});

test("natural shell exit still cleans up surviving descendants", async () => {
  const h = await create();
  h.exit(0);
  h.close();
  expect(h.kill.mock.calls).toEqual([[-h.task.pid, "SIGTERM"]]);
  expect(h.registry.get(h.task.id).status).toBe("running");
  await vi.advanceTimersByTimeAsync(100);
  expect((await h.registry.wait(h.task.id)).outcome).toEqual({
    kind: "exited",
    code: 0,
  });
  expect(h.kill.mock.calls).toEqual([
    [-h.task.pid, "SIGTERM"],
    [-h.task.pid, "SIGKILL"],
  ]);
  expect(vi.getTimerCount()).toBe(0);
});
