import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
  ExecutionObserver,
  ExecutionOutcome,
  Executor,
} from "./execution.ts";
import { Registry } from "./registry.ts";

// Fixtures use mkdtemp; these policy tests must not depend on POSIX ownership
// checks. directory.test.ts and extension integration retain real validation.
vi.mock("./directory.ts", () => ({
  privateDirectory: (path: string) => path,
}));

function fakeExecutor() {
  const attempts: ReturnType<typeof attempt>[] = [];
  function attempt(command: string, cwd: string, observer: ExecutionObserver) {
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let exited = false;
    let completed = false;
    const execution = {
      pid: 42,
      ready: new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      }),
      stop: vi.fn(),
    };
    return {
      command,
      cwd,
      observer,
      execution,
      ready: () => resolveReady(),
      fail: (error: Error) => {
        exited = true;
        observer.onSpawnError(error);
        rejectReady(error);
      },
      exit: (outcome: ExecutionOutcome = { kind: "exited", code: 0 }) => {
        exited = true;
        observer.onExit(outcome);
      },
      complete: () => {
        if (!exited) observer.onExit({ kind: "exited", code: 0 });
        if (!completed) observer.onComplete();
        exited = true;
        completed = true;
      },
    };
  }
  const executor: Executor = {
    start(command, cwd, observer) {
      const pending = attempt(command, cwd, observer);
      attempts.push(pending);
      return pending.execution;
    },
  };
  return { executor, attempts };
}

type Fixture = ReturnType<typeof fakeExecutor> & {
  directory: string;
  registry: Registry;
};
const fixtures: Fixture[] = [];
async function create(maxOutputBytes = 1024): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "pix-bg-executor-"));
  const fake = fakeExecutor();
  const registry = new Registry({
    executor: fake.executor,
    outputDir: directory,
    maxOutputBytes,
  });
  const fixture = { directory, registry, ...fake };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const pending of fixture.attempts) {
      pending.ready();
      pending.complete();
    }
    await fixture.registry.disposeAll();
    await rm(fixture.directory, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

test("registry delegates launch and waits for the executor's acknowledgment", async () => {
  const h = await create();
  const changed = vi.fn();
  h.registry.subscribe(changed);
  const starting = h.registry.start({ command: "fixture", cwd: "/workspace" });
  const pending = h.attempts[0]!;
  let started = false;
  void starting.then(() => {
    started = true;
  });
  await Promise.resolve();
  expect(pending.command).toBe("fixture");
  expect(pending.cwd).toBe("/workspace");
  expect(started).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  pending.ready();
  const task = await starting;
  expect(task.pid).toBe(42);
  expect(changed).toHaveBeenCalledExactlyOnceWith(task);
});

test("shell exit clears the timeout but completion waits for executor cleanup", async () => {
  const h = await create();
  vi.useFakeTimers();
  const starting = h.registry.start({
    command: "fixture",
    cwd: "/",
    timeout: 0.1,
  });
  const pending = h.attempts[0]!;
  pending.ready();
  const task = await starting;
  pending.observer.onData("stdout", Buffer.from([0xe7]));
  pending.exit({ kind: "exited", code: 7 });
  pending.observer.onData("stderr", Buffer.from("err"));
  pending.observer.onData("stdout", Buffer.from([0x95, 0x8c]));
  await vi.advanceTimersByTimeAsync(1000);
  expect(pending.execution.stop).not.toHaveBeenCalled();
  expect(h.registry.get(task.id).status).toBe("running");
  await expect(h.registry.stop(task.id, "user")).rejects.toThrow(
    "already exited",
  );
  pending.complete();
  const finished = await h.registry.wait(task.id);
  expect(finished.outcome).toEqual({ kind: "exited", code: 7 });
  expect(finished.outputBytes).toBe(6);
  expect(await readFile(task.outputPath, "utf8")).toBe("err界");
});

test("output caps record the reason before stopping and wait for cleanup", async () => {
  const h = await create(3);
  const starting = h.registry.start({ command: "fixture", cwd: "/" });
  const pending = h.attempts[0]!;
  pending.ready();
  const task = await starting;
  pending.execution.stop.mockImplementation(() => {
    expect(h.registry.get(task.id).status).toBe("stopping");
    pending.exit({ kind: "signaled", signal: "SIGTERM", code: 143 });
  });
  pending.observer.onData("stdout", Buffer.from("\x1b[31mabcdef\x1b[0m"));
  pending.observer.onData("stderr", Buffer.from("ignored"));
  expect(pending.execution.stop).toHaveBeenCalledOnce();
  expect(h.registry.get(task.id).status).toBe("stopping");
  pending.complete();
  expect((await h.registry.wait(task.id)).outcome).toEqual({
    kind: "output_capped",
  });
  expect(await readFile(task.outputPath, "utf8")).toBe("abc");
});

test("a timeout retains its reason when a stop request arrives during cleanup", async () => {
  const h = await create();
  vi.useFakeTimers();
  const starting = h.registry.start({
    command: "fixture",
    cwd: "/",
    timeout: 0.1,
  });
  const pending = h.attempts[0]!;
  pending.ready();
  const task = await starting;
  await vi.advanceTimersByTimeAsync(100);
  expect(pending.execution.stop).toHaveBeenCalledOnce();
  const stopped = h.registry.stop(task.id, "user");
  pending.complete();
  expect((await stopped).outcome).toEqual({ kind: "timed_out" });
});

test("output failures become task failures rather than executor exit results", async () => {
  const h = await create();
  const starting = h.registry.start({ command: "fixture", cwd: "/" });
  const pending = h.attempts[0]!;
  pending.ready();
  const task = await starting;
  pending.observer.onOutputError(new Error("pipe failed"));
  expect(pending.execution.stop).toHaveBeenCalledOnce();
  pending.complete();
  expect((await h.registry.wait(task.id)).outcome).toEqual({
    kind: "failed",
    message: "pipe failed",
  });
});

test("shutdown owns still-launching executions and joins their completion", async () => {
  const h = await create();
  const starting = h.registry.start({ command: "fixture", cwd: "/" });
  const pending = h.attempts[0]!;
  const disposing = h.registry.disposeAll();
  expect(pending.execution.stop).toHaveBeenCalledOnce();
  pending.ready();
  const task = await starting;
  expect(task.status).toBe("stopping");
  pending.complete();
  await disposing;
  expect((await h.registry.wait(task.id)).outcome).toEqual({
    kind: "killed",
    by: "shutdown",
  });
});

test("an executor's asynchronous launch failure is not retained as a task", async () => {
  const h = await create();
  const changed = vi.fn();
  h.registry.subscribe(changed);
  const starting = h.registry.start({ command: "fixture", cwd: "/" });
  const pending = h.attempts[0]!;
  const failed = expect(starting).rejects.toThrow("launch failed");
  pending.fail(new Error("launch failed"));
  pending.complete();
  await failed;
  expect(h.registry.list()).toEqual([]);
  expect(changed).not.toHaveBeenCalled();
});
