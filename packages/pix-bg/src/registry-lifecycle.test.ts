import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, writeSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PosixExecutor } from "./posix-execution.ts";
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

function launch(timeout?: number) {
  const stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  const child = Object.assign(new EventEmitter(), {
    pid: 123456,
    stdout,
    stderr,
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  const registry = new Registry({
    executor: new PosixExecutor({
      shell: { shell: "/bin/sh", args: ["-c"] },
      graceMs: 100,
    }),
    outputDir: "/fake/bg",
    maxOutputBytes: 1024,
  });
  const changed = vi.fn();
  registry.subscribe(changed);
  const starting = registry.start({
    command: "fixture",
    cwd: "/",
    ...(timeout === undefined ? {} : { timeout }),
  });
  return { registry, child, starting, stdout, stderr, changed };
}

async function create(timeout?: number) {
  const h = launch(timeout);
  const { child } = h;
  child.emit("spawn");
  const task = await h.starting;
  return {
    ...h,
    task,
    kill: vi.mocked(process.kill),
    exit: (code: number | null = 0, signal: NodeJS.Signals | null = null) =>
      child.emit("exit", code, signal),
    close: () => child.emit("close"),
  };
}

test("launch waits for spawn acknowledgment before returning a task", async () => {
  const h = launch();
  let started = false;
  void h.starting.then(() => {
    started = true;
  });
  await Promise.resolve();
  expect(started).toBe(false);
  expect(h.changed).not.toHaveBeenCalled();
  expect(spawn).toHaveBeenCalledExactlyOnceWith("/bin/sh", ["-c", "fixture"], {
    cwd: "/",
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  h.child.emit("spawn");
  const task = await h.starting;
  expect(task.pid).toBe(h.child.pid);
  expect(task.status).toBe("running");
  expect(h.changed).toHaveBeenCalledExactlyOnceWith(task);
  vi.mocked(process.kill).mockImplementation(() => {
    throw signalError("ESRCH");
  });
  h.child.emit("exit", 0, null);
  h.child.emit("close");
  await h.registry.disposeAll();
});

test("a synchronous spawn failure closes its log without retaining a task", async () => {
  const error = new Error("invalid spawn arguments");
  vi.mocked(spawn).mockImplementationOnce(() => {
    throw error;
  });
  const h = launch();
  await expect(h.starting).rejects.toBe(error);
  expect(h.registry.list()).toEqual([]);
  expect(closeSync).toHaveBeenCalledExactlyOnceWith(42);
  expect(h.changed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("failed launch disappears but shutdown still waits for close", async () => {
  const h = launch();
  const task = h.registry.list()[0]!;
  const failed = expect(h.starting).rejects.toThrow("spawn failed");
  const disposing = h.registry.disposeAll();
  let disposed = false;
  void disposing.then(() => {
    disposed = true;
  });
  h.child.emit("error", new Error("spawn failed"));
  await failed;
  expect(h.registry.list()).toEqual([]);
  expect(disposed).toBe(false);
  expect(closeSync).not.toHaveBeenCalled();
  h.child.emit("close");
  await disposing;
  expect(disposed).toBe(true);
  expect(closeSync).toHaveBeenCalledExactlyOnceWith(42);
  expect(h.changed).not.toHaveBeenCalled();
  expect(() => h.registry.get(task.id)).toThrow("Unknown");
  expect(vi.getTimerCount()).toBe(0);
});

test("a shell without an exit code or signal is never successful", async () => {
  const h = await create();
  h.kill.mockImplementation(() => {
    throw signalError("ESRCH");
  });
  h.exit(null, null);
  h.close();
  expect((await h.registry.wait(h.task.id)).outcome).toEqual({
    kind: "failed",
    message: "Command terminated without an exit code",
  });
});

test("retains post-exit output and decodes stdout and stderr independently", async () => {
  const h = await create();
  h.stdout.emit("data", Buffer.from([0xe7]));
  h.stderr.emit("data", Buffer.from("err"));
  h.exit(0);
  h.stdout.emit("data", Buffer.from([0x95, 0x8c]));
  h.close();
  expect(closeSync).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect((await h.registry.wait(h.task.id)).outputBytes).toBe(6);
  expect(writeSync).toHaveBeenCalledTimes(2);
  expect(writeSync).toHaveBeenNthCalledWith(1, 42, Buffer.from("err"), 0);
  expect(writeSync).toHaveBeenNthCalledWith(2, 42, Buffer.from("界"), 0);
  expect(closeSync).toHaveBeenCalledExactlyOnceWith(42);
});

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

test.each(["stop", "disposal", "exit"] as const)(
  "failed escalation remains visible and retryable via %s",
  async (retry) => {
    const h = await create();
    const stopped = h.registry.stop(h.task.id, "user");
    const error = signalError("EPERM");
    h.kill.mockImplementation(() => {
      throw error;
    });
    expect(() => vi.advanceTimersByTime(100)).toThrow(error);
    expect(h.registry.get(h.task.id).status).toBe("stopping");
    expect(closeSync).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    h.kill.mockReturnValue(true);
    let retried: Promise<unknown> | undefined;
    if (retry === "stop") retried = h.registry.stop(h.task.id, "agent");
    else if (retry === "disposal") retried = h.registry.disposeAll();
    else h.exit(null, "SIGTERM");
    expect(h.kill).toHaveBeenLastCalledWith(-h.task.pid, "SIGTERM");
    expect(vi.getTimerCount()).toBe(1);

    if (retry !== "exit") h.exit(null, "SIGTERM");
    h.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.kill).toHaveBeenLastCalledWith(-h.task.pid, "SIGKILL");
    expect((await stopped).outcome).toEqual({ kind: "killed", by: "user" });
    await retried;
    expect(closeSync).toHaveBeenCalledExactlyOnceWith(42);
    expect(vi.getTimerCount()).toBe(0);
  },
);

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
