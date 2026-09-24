import { afterEach, expect, test, vi } from "vitest";
import { Notifier } from "./notify.ts";
import type { Outcome, Task } from "./registry.ts";

function task(id: string, outcome: Outcome): Task {
  return {
    id,
    name: "test",
    command: "true",
    cwd: "/tmp",
    pid: 1,
    outputPath: "/missing",
    outputBytes: 0,
    startedAt: 0,
    endedAt: 1,
    status: "finished",
    outcome,
  };
}

afterEach(() => vi.useRealTimers());

test("batches natural, timeout, cap, and signal completions into a follow-up turn", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const notifier = new Notifier(send);
  notifier.completed(task("a", { kind: "exited", code: 0 }));
  notifier.completed(task("b", { kind: "timed_out" }));
  notifier.completed(task("c", { kind: "output_capped" }));
  notifier.completed(
    task("d", { kind: "signaled", signal: "SIGKILL", code: 137 }),
  );
  vi.advanceTimersByTime(249);
  expect(send).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0].details.tasks).toHaveLength(4);
  expect(send.mock.calls[0]?.[1]).toEqual({
    deliverAs: "followUp",
    triggerTurn: true,
  });
  notifier.dispose();
});

test("user kills queue next-turn messages; agent and shutdown kills are silent", () => {
  const send = vi.fn();
  const notifier = new Notifier(send);
  for (const by of ["agent", "shutdown", "user"] as const)
    notifier.completed(task(by, { kind: "killed", by }));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[1]).toEqual({
    deliverAs: "nextTurn",
    triggerTurn: false,
  });
  expect(send.mock.calls[0]?.[0].details.tasks[0].id).toBe("user");
  notifier.dispose();
});

test("shutdown cancels pending and future delivery", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const notifier = new Notifier(send);
  notifier.completed(task("a", { kind: "exited", code: 0 }));
  notifier.dispose();
  notifier.dispose();
  notifier.completed(task("b", { kind: "killed", by: "user" }));
  vi.runAllTimers();
  expect(send).not.toHaveBeenCalled();
});

test("headless completion never starts a turn", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const notifier = new Notifier(send, false);
  notifier.completed(task("a", { kind: "exited", code: 0 }));
  vi.runAllTimers();
  expect(send.mock.calls[0]?.[1]).toEqual({
    deliverAs: "nextTurn",
    triggerTurn: false,
  });
});
