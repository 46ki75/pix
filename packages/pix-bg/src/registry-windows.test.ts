import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, writeSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Registry } from "./registry.ts";
import { WindowsExecutor } from "./windows-execution.ts";

// Exercise the real policy/backend boundary while controlling OS error delivery.
// No actual processes, sockets, directories, or file descriptors are created.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:net", () => ({ createServer: vi.fn() }));
vi.mock("node:fs", () => ({
  openSync: vi.fn(() => 42),
  closeSync: vi.fn(),
  writeSync: vi.fn((_fd: number, buffer: Buffer) => buffer.length),
}));
vi.mock("./directory.ts", () => ({ privateDirectory: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubEnv("MSYS", undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function create(maxOutputBytes = 1024, timeout?: number) {
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
  const errors = vi.fn();
  const registry = new Registry({
    executor: new WindowsExecutor({
      shell: { shell: "C:\\Git\\bash.exe", args: ["-c"] },
      startupMs: 1000,
    }),
    outputDir: "/fake/bg",
    maxOutputBytes,
    onError: errors,
  });
  const starting = registry.start({
    command: "fixture",
    cwd: "C:\\work",
    ...(timeout === undefined ? {} : { timeout }),
  });
  const accept = vi.mocked(createServer).mock.calls.at(-1)![0] as unknown as (
    socket: Socket,
  ) => void;
  accept(socket as unknown as Socket);
  socket.emit("data", "ready\n");
  const task = await starting;
  const deny = (kind: string) => {
    const error = Object.assign(new Error("access denied"), { code: "EPERM" });
    child.kill.mockImplementation(() => {
      if (kind === "thrown") throw error;
      child.emit("error", error);
      return false;
    });
    return error;
  };
  const allow = () =>
    child.kill.mockImplementation(() => {
      child.killed = true;
      return true;
    });
  const close = () => {
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
    expect(closeSync).not.toHaveBeenCalled();
    socket.emit("close");
  };
  return { registry, task, errors, child, socket, deny, allow, close };
}

for (const route of ["cap", "timeout", "pipe", "write"] as const) {
  test.each(["emitted", "thrown"])(
    `automatic ${route} stop contains %s EPERM, reports it, and permits retry`,
    async (kind) => {
      const h = await create(
        route === "cap" ? 3 : 1024,
        route === "timeout" ? 0.1 : undefined,
      );
      const error = h.deny(kind);
      const ioError = new Error("output failed");
      if (route === "timeout") {
        expect(() => vi.advanceTimersByTime(100)).not.toThrow();
      } else if (route === "pipe") {
        expect(() => h.child.stdout.emit("error", ioError)).not.toThrow();
      } else {
        if (route === "write")
          vi.mocked(writeSync).mockImplementationOnce(() => {
            throw ioError;
          });
        expect(() =>
          h.child.stdout.emit("data", Buffer.from("abcdef")),
        ).not.toThrow();
      }
      expect(h.child.kill).toHaveBeenCalledOnce();
      expect(h.errors).toHaveBeenCalledWith(
        error,
        expect.objectContaining({ id: h.task.id, status: "stopping" }),
      );
      expect(h.registry.get(h.task.id)).toMatchObject({
        status: "stopping",
        lastError: "access denied",
      });
      expect(closeSync).not.toHaveBeenCalled();
      h.allow();
      const stopped = h.registry.stop(h.task.id, "agent");
      expect(h.child.kill).toHaveBeenCalledTimes(2);
      h.close();
      const outcome = (await stopped).outcome;
      if (route === "cap") expect(outcome).toEqual({ kind: "output_capped" });
      else if (route === "timeout")
        expect(outcome).toEqual({ kind: "timed_out" });
      else expect(outcome?.kind).toBe("failed");
      expect(closeSync).toHaveBeenCalledExactlyOnceWith(42);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
}

for (const route of ["stop", "shutdown"] as const) {
  test.each(["emitted", "thrown"])(
    `explicit ${route} preserves %s delivery failure and permits retry`,
    async (kind) => {
      const h = await create();
      const error = h.deny(kind);
      if (route === "stop")
        await expect(h.registry.stop(h.task.id, "user")).rejects.toBe(error);
      else expect(() => h.registry.disposeAll()).toThrow(error);
      expect(h.errors).not.toHaveBeenCalled();
      expect(closeSync).not.toHaveBeenCalled();
      h.allow();
      const stopped =
        route === "stop"
          ? h.registry.stop(h.task.id, "agent")
          : h.registry.disposeAll();
      h.close();
      await stopped;
      expect((await h.registry.wait(h.task.id)).outcome).toEqual({
        kind: "killed",
        by: route === "stop" ? "user" : "shutdown",
      });
      expect(closeSync).toHaveBeenCalledExactlyOnceWith(42);
    },
  );
}
