import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WindowsExecutor } from "./windows-execution.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:net", () => ({ createServer: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function create() {
  const server = Object.assign(new EventEmitter(), {
    listening: true,
    listen: vi.fn(),
    close: vi.fn(() => {
      server.listening = false;
    }),
  });
  const socket = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
    destroy: vi.fn(),
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    killed: false,
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    kill: vi.fn(() => {
      child.killed = true;
      return true;
    }),
  });
  vi.mocked(createServer).mockReturnValue(server as unknown as Server);
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  const observer = {
    onData: vi.fn(),
    onOutputError: vi.fn(),
    onExit: vi.fn(),
    onSpawnError: vi.fn(),
    onComplete: vi.fn(),
  };
  const executor = new WindowsExecutor({
    shell: { shell: "C:\\Git Bash\\bash.exe", args: ["-c"] },
    startupMs: 1000,
  });
  const execution = executor.start("printf '界'", "C:\\work space", observer);
  const connect = () => {
    const listener = vi.mocked(createServer).mock.calls[0]![0] as unknown as (
      socket: Socket,
    ) => void;
    listener(socket as unknown as Socket);
  };
  const close = () => {
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
    socket.emit("close");
  };
  return {
    server,
    socket,
    child,
    observer,
    executor,
    execution,
    connect,
    close,
  };
}

test("returns the supervisor PID but acknowledges only a job-contained command", async () => {
  const h = create();
  expect(h.execution.pid).toBe(12345);
  for (const callback of Object.values(h.observer))
    expect(callback).not.toHaveBeenCalled();
  let ready = false;
  void h.execution.ready.then(() => {
    ready = true;
  });
  h.child.emit("spawn");
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(h.server.listen).toHaveBeenCalledWith({
    path: expect.stringContaining("\\\\.\\pipe\\pix-bg-"),
    readableAll: false,
    writableAll: false,
  });
  const payload = JSON.parse(h.child.stdin.end.mock.calls[0]![0] as string);
  expect(payload).toMatchObject({
    shell: "C:\\Git Bash\\bash.exe",
    args: ["-c", "printf '界'"],
    cwd: "C:\\work space",
  });
  expect(payload.pipe).toMatch(/^pix-bg-[0-9a-f]{48}$/);
  expect(spawn).toHaveBeenCalledWith(
    expect.stringContaining("powershell.exe"),
    expect.arrayContaining(["-NoProfile", "-NonInteractive", "-File"]),
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: expect.any(Object),
    },
  );
  h.connect();
  h.socket.emit("data", "rea");
  expect(ready).toBe(false);
  h.socket.emit("data", "dy\n");
  await h.execution.ready;
  expect(ready).toBe(true);
  h.close();
});

test("separates PowerShell helper configuration from the original command environment", async () => {
  vi.stubEnv("PSModulePath", "C:\\custom modules 界");
  vi.stubEnv("PSExecutionPolicyPreference", "RemoteSigned");
  const h = create();
  const payload = JSON.parse(h.child.stdin.end.mock.calls[0]![0] as string);
  expect(payload.environment).toContain("PSModulePath=C:\\custom modules 界");
  expect(payload.environment).toContain(
    "PSExecutionPolicyPreference=RemoteSigned",
  );
  const options = vi.mocked(spawn).mock.calls[0]![2]!;
  expect(
    Object.keys(options.env ?? {}).some(
      (key) => key.toUpperCase() === "PSMODULEPATH",
    ),
  ).toBe(false);
  expect(options.env?.PSExecutionPolicyPreference).toBe("RemoteSigned");
  h.connect();
  h.socket.emit("data", "ready\nexit:0\n");
  await h.execution.ready;
  h.close();
});

test("keeps raw sources distinct and joins helper, output, and control closure", async () => {
  const h = create();
  h.connect();
  h.socket.emit("data", "ready\nexit:7\n");
  await h.execution.ready;
  expect(h.observer.onExit).toHaveBeenCalledExactlyOnceWith({
    kind: "exited",
    code: 7,
  });
  const stdout = Buffer.from([0xe7]);
  const stderr = Buffer.from("err");
  h.child.stdout.emit("data", stdout);
  h.child.stderr.emit("data", stderr);
  expect(h.observer.onData.mock.calls).toEqual([
    ["stdout", stdout],
    ["stderr", stderr],
  ]);
  h.child.emit("exit", 0, null);
  h.child.emit("close", 0, null);
  expect(h.observer.onComplete).not.toHaveBeenCalled();
  h.socket.emit("close");
  expect(h.observer.onComplete).toHaveBeenCalledOnce();
  h.execution.stop();
  h.child.stdout.emit("data", Buffer.from("late"));
  expect(h.observer.onData).toHaveBeenCalledTimes(2);
  expect(h.child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("preserves a result arriving after the helper exit event", async () => {
  const h = create();
  h.connect();
  h.socket.emit("data", "ready\n");
  await h.execution.ready;
  h.child.emit("exit", 0, null);
  h.child.emit("close", 0, null);
  h.socket.emit("data", "exit:0\n");
  h.socket.emit("close");
  expect(h.observer.onExit).toHaveBeenCalledExactlyOnceWith({
    kind: "exited",
    code: 0,
  });
  expect(h.observer.onComplete).toHaveBeenCalledOnce();
});

test("accepts a pending control connection even when helper closure arrives first", async () => {
  const h = create();
  const ready = h.execution.ready.then(
    () => "ready",
    () => "failed",
  );
  h.child.emit("exit", 0, null);
  h.child.emit("close", 0, null);
  h.connect();
  h.socket.emit("data", "ready\nexit:0\n");
  expect(await ready).toBe("ready");
  h.socket.emit("close");
  expect(h.observer.onSpawnError).not.toHaveBeenCalled();
  expect(h.observer.onExit).toHaveBeenCalledExactlyOnceWith({
    kind: "exited",
    code: 0,
  });
  expect(h.observer.onComplete).toHaveBeenCalledOnce();
});

test("completes once when an early stop loses control before acknowledgment", async () => {
  const h = create();
  const ready = h.execution.ready.catch(() => undefined);
  h.execution.stop();
  h.connect();
  h.socket.emit("close");
  h.child.emit("exit", 1, null);
  h.child.emit("close", 1, null);
  await ready;
  expect(h.observer.onSpawnError).toHaveBeenCalledOnce();
  expect(h.observer.onComplete).toHaveBeenCalledOnce();
});

test("queues shutdown during launch and force-stops only after acknowledgment", async () => {
  const h = create();
  h.execution.stop();
  expect(h.child.kill).not.toHaveBeenCalled();
  h.connect();
  h.socket.emit("data", "ready\n");
  await h.execution.ready;
  expect(h.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  h.execution.stop();
  expect(h.child.kill).toHaveBeenCalledOnce();
  h.close();
  expect(h.observer.onExit).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "failed" }),
  );
  expect(h.observer.onComplete).toHaveBeenCalledOnce();
});

test.each(["emitted", "thrown"])(
  "reports a deferred %s stop failure without an uncaught error and permits retry",
  async (kind) => {
    const h = create();
    const error = Object.assign(new Error("access denied"), { code: "EPERM" });
    h.execution.stop();
    h.child.kill.mockImplementation(() => {
      if (kind === "thrown") throw error;
      h.child.emit("error", error);
      return false;
    });
    // Registry error observers request stop themselves; reporting must not turn
    // a persistent delivery failure into recursive signaling or an uncaught error.
    h.observer.onOutputError.mockImplementation(() => h.execution.stop());
    h.connect();
    expect(() => h.socket.emit("data", "ready\n")).not.toThrow();
    await h.execution.ready;
    expect(h.observer.onOutputError).toHaveBeenCalledExactlyOnceWith(error);
    expect(h.child.kill).toHaveBeenCalledOnce();
    h.child.kill.mockImplementation(() => {
      h.child.killed = true;
      return true;
    });
    h.execution.stop();
    expect(h.child.kill).toHaveBeenCalledTimes(2);
    h.close();
    expect(h.observer.onComplete).toHaveBeenCalledOnce();
  },
);

test("surfaces signal-delivery errors synchronously and permits retry", async () => {
  const h = create();
  h.connect();
  h.socket.emit("data", "ready\n");
  await h.execution.ready;
  const error = Object.assign(new Error("access denied"), { code: "EPERM" });
  h.child.kill.mockImplementationOnce(() => {
    h.child.emit("error", error);
    return false;
  });
  expect(() => h.execution.stop()).toThrow(error);
  expect(h.observer.onOutputError).not.toHaveBeenCalled();
  h.execution.stop();
  expect(h.child.kill).toHaveBeenCalledTimes(2);
  h.close();
});

test.each(["pipe", "timeout", "spawn"])(
  "rejects %s startup failures but waits for resource closure",
  async (kind) => {
    const h = create();
    const failed = expect(h.execution.ready).rejects.toThrow();
    if (kind === "pipe") {
      h.connect();
      h.socket.emit(
        "data",
        `error:${Buffer.from("CreateProcess failed").toString("base64")}\n`,
      );
    } else if (kind === "timeout") {
      await vi.advanceTimersByTimeAsync(1000);
    } else {
      h.child.emit("error", new Error("ENOENT"));
    }
    await failed;
    expect(h.observer.onSpawnError).toHaveBeenCalledOnce();
    expect(h.observer.onComplete).not.toHaveBeenCalled();
    h.close();
    expect(h.observer.onExit).not.toHaveBeenCalled();
    expect(h.observer.onComplete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each(["exit:0", "ready\nready", "ready\nexit:4294967296"])(
  "rejects malformed or out-of-order control frames: %s",
  async (frame) => {
    const h = create();
    const ready = h.execution.ready.catch(() => {});
    h.connect();
    h.socket.emit("data", `${frame}\n`);
    await ready;
    expect(h.child.kill).toHaveBeenCalledOnce();
    expect(
      h.observer.onSpawnError.mock.calls.length +
        h.observer.onOutputError.mock.calls.length,
    ).toBe(1);
    h.close();
  },
);
