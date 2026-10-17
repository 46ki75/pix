import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PosixExecutor } from "./posix-execution.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

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

function create() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123456,
    stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  const observer = {
    onData: vi.fn(),
    onOutputError: vi.fn(),
    onExit: vi.fn(),
    onSpawnError: vi.fn(),
    onComplete: vi.fn(),
  };
  const executor = new PosixExecutor({
    shell: { shell: "/bin/sh", args: ["-c"] },
    graceMs: 100,
  });
  const execution = executor.start("fixture", "/", observer);
  return { child, observer, execution };
}

test("returns a handle before launch acknowledgment and preserves raw output sources", async () => {
  const h = create();
  expect(h.execution.pid).toBe(h.child.pid);
  for (const listener of Object.values(h.observer))
    expect(listener).not.toHaveBeenCalled();
  let ready = false;
  void h.execution.ready.then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  h.child.emit("spawn");
  await h.execution.ready;
  const chunk = Buffer.from([0xe7, 0x1b]);
  h.child.stdout.emit("data", chunk);
  h.child.stderr.emit("data", chunk);
  expect(h.observer.onData).toHaveBeenNthCalledWith(1, "stdout", chunk);
  expect(h.observer.onData).toHaveBeenNthCalledWith(2, "stderr", chunk);
  expect(h.observer.onData.mock.calls[0]?.[1]).toBe(chunk);
  const error = new Error("pipe failed");
  h.child.stderr.emit("error", error);
  expect(h.observer.onOutputError).toHaveBeenCalledExactlyOnceWith(error);
});

test.each(["before", "after"])(
  "completion waits for output closure %s group cleanup",
  async (order) => {
    const h = create();
    h.child.emit("spawn");
    await h.execution.ready;
    h.child.emit("exit", 0, null);
    expect(h.observer.onExit).toHaveBeenCalledExactlyOnceWith({
      kind: "exited",
      code: 0,
    });
    if (order === "before") h.child.emit("close");
    expect(h.observer.onComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(process.kill).toHaveBeenNthCalledWith(
      1,
      -h.execution.pid,
      "SIGTERM",
    );
    expect(process.kill).toHaveBeenNthCalledWith(
      2,
      -h.execution.pid,
      "SIGKILL",
    );
    if (order === "after") {
      expect(h.observer.onComplete).not.toHaveBeenCalled();
      h.child.emit("close");
    }
    expect(h.observer.onComplete).toHaveBeenCalledOnce();
    h.execution.stop();
    expect(process.kill).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each([
  [137, null, { kind: "exited", code: 137 }],
  [null, "SIGKILL", { kind: "signaled", signal: "SIGKILL", code: 137 }],
  [
    null,
    null,
    { kind: "failed", message: "Command terminated without an exit code" },
  ],
])(
  "preserves the distinction between exit code %s and signal %s",
  async (code, signal, outcome) => {
    const h = create();
    h.child.emit("spawn");
    await h.execution.ready;
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    h.child.emit("exit", code, signal);
    h.child.emit("close");
    expect(h.observer.onExit).toHaveBeenCalledExactlyOnceWith(outcome);
    expect(h.observer.onComplete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("spawn failure rejects readiness but completes only after output closure", async () => {
  const h = create();
  const error = new Error("spawn failed");
  const failed = expect(h.execution.ready).rejects.toBe(error);
  h.child.emit("error", error);
  await failed;
  expect(h.observer.onSpawnError).toHaveBeenCalledExactlyOnceWith(error);
  expect(h.observer.onExit).not.toHaveBeenCalled();
  expect(h.observer.onComplete).not.toHaveBeenCalled();
  h.child.emit("close");
  expect(h.observer.onComplete).toHaveBeenCalledOnce();
  expect(process.kill).not.toHaveBeenCalled();
});
