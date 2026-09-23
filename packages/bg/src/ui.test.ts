import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import type { Outcome, Registry, Task } from "./registry.ts";
import { OutputView, TaskUI } from "./ui.ts";

const task: Task = {
  id: "abc",
  name: "界 test",
  command: "sleep 30",
  cwd: "/tmp",
  pid: 1,
  outputPath: "/missing",
  outputBytes: 0,
  startedAt: 0,
  status: "running",
};

function indicatorContext() {
  let widget: Component | undefined;
  const requestRender = vi.fn();
  const theme = {
    fg: vi.fn(
      (color: string, text: string) =>
        `\x1b[${color === "muted" ? 37 : 90}m${text}\x1b[39m`,
    ),
    getColorMode: vi.fn<() => "truecolor" | "256color">(() => "truecolor"),
  };
  const ui = {
    theme,
    setStatus: vi.fn(),
    setWidget: vi.fn(
      (
        _key: string,
        factory?: (tui: { requestRender: () => void }) => Component,
      ) => {
        widget = factory?.({ requestRender });
      },
    ),
    select: vi.fn(),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
  };
  return {
    ctx: { ui } as unknown as ExtensionCommandContext,
    ui,
    requestRender,
    get widget() {
      return widget;
    },
    text: () => stripVTControlCharacters(widget?.render(100).join("\n") ?? ""),
  };
}

test("indicator appears on first task, counts stopping as running, and retains finished totals", () => {
  const tasks: Task[] = [];
  const harness = indicatorContext();
  const ui = new TaskUI(
    { list: () => tasks } as unknown as Registry,
    harness.ctx,
  );
  expect(harness.ui.setWidget).not.toHaveBeenCalled();
  tasks.push(
    task,
    { ...task, status: "stopping" },
    { ...task, status: "finished", outcome: { kind: "exited", code: 0 } },
  );
  ui.update();
  expect(harness.ui.setWidget).toHaveBeenCalledWith(
    "pix-bg",
    expect.any(Function),
    { placement: "belowEditor" },
  );
  expect(harness.text()).toBe(
    "| ⏺ Running: 2 ⏺ Finished: 1 | /bg → Show BG Tasks |",
  );
  tasks[0] = {
    ...task,
    status: "finished",
    outcome: { kind: "exited", code: 0 },
  };
  tasks[1] = {
    ...task,
    status: "finished",
    outcome: { kind: "killed", by: "user" },
  };
  ui.update();
  expect(harness.text()).toContain("Running: 0 ⏺ Finished: 3");
  expect(harness.ui.setWidget).toHaveBeenCalledTimes(1);
  expect(harness.requestRender).toHaveBeenCalled();
  ui.dispose();
  const calls = harness.ui.setWidget.mock.calls.length;
  ui.update();
  ui.dispose();
  expect(harness.ui.setWidget).toHaveBeenCalledTimes(calls);
  expect(harness.widget).toBeUndefined();
  // A fresh runtime never rebuilds the finished counter from session history.
  const replacement = new TaskUI(
    { list: () => [] } as unknown as Registry,
    harness.ctx,
  );
  expect(harness.widget).toBeUndefined();
  replacement.dispose();
});

const outcomes: Outcome[] = [
  { kind: "exited", code: 0 },
  { kind: "exited", code: 3 },
  { kind: "signaled", signal: "SIGKILL", code: 137 },
  { kind: "timed_out" },
  { kind: "output_capped" },
  { kind: "failed", message: "I/O error" },
  { kind: "killed", by: "agent" },
  { kind: "killed", by: "user" },
  { kind: "killed", by: "shutdown" },
];
test.each(outcomes)(
  "indicator includes every finished outcome: %j",
  (outcome) => {
    const harness = indicatorContext();
    const ui = new TaskUI(
      {
        list: () => [{ ...task, status: "finished", outcome }],
      } as unknown as Registry,
      harness.ctx,
    );
    expect(harness.text()).toContain("Running: 0 ⏺ Finished: 1");
    ui.dispose();
  },
);

test("indicator uses blue, current theme tokens, a palette fallback, and bounded widths", () => {
  const harness = indicatorContext();
  const ui = new TaskUI(
    { list: () => [task] } as unknown as Registry,
    harness.ctx,
  );
  const first = harness.widget?.render(100).join("");
  expect(first).toContain("\x1b[38;2;104;119;159m⏺ Running: 1\x1b[39m");
  expect(harness.ui.theme.fg).toHaveBeenCalledWith(
    "muted",
    expect.stringContaining("Finished: 0"),
  );
  expect(harness.ui.theme.fg).toHaveBeenCalledWith(
    "dim",
    expect.stringContaining("/bg → Show BG Tasks"),
  );
  harness.ui.theme.fg.mockImplementation(
    (_color, text) => `\x1b[36m${text}\x1b[39m`,
  );
  harness.widget?.invalidate();
  expect(harness.widget?.render(100).join("")).toContain("\x1b[36m");
  expect(harness.widget?.render(100).join("")).not.toBe(first);
  harness.ui.theme.getColorMode.mockReturnValue("256color");
  expect(harness.widget?.render(100).join("")).toContain(
    "\x1b[38;5;67m⏺ Running: 1",
  );
  for (const width of [1, 12, 40, 80]) {
    const lines = harness.widget?.render(width);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines?.[0] ?? "")).toBeLessThanOrEqual(width);
  }
  ui.dispose();
});

test("viewer fits narrow widths, scrolls, refreshes, and releases its timer", () => {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), "pix-bg-ui-"));
  const outputPath = join(directory, "output.log");
  writeFileSync(
    outputPath,
    Array.from({ length: 100 }, (_, i) => `line ${i} 界`).join("\n"),
  );
  const current = { ...task, outputPath };
  const render = vi.fn();
  const done = vi.fn();
  const view = new OutputView(
    () => current,
    { fg: (_color, text) => text },
    () => 10,
    render,
    done,
  );
  try {
    for (const width of [1, 12, 80]) {
      const lines = view.render(width);
      expect(lines.length).toBeLessThanOrEqual(10);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(view.render(80).join("\n")).toContain("line 99");
    view.handleInput("\x1b[H");
    expect(view.render(80).join("\n")).toContain("line 0");
    view.handleInput("\x1b[F");
    writeFileSync(outputPath, "updated output");
    vi.advanceTimersByTime(1000);
    expect(view.render(80).join("\n")).toContain("updated output");
    view.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const count = render.mock.calls.length;
    vi.advanceTimersByTime(2000);
    expect(render).toHaveBeenCalledTimes(count);
  } finally {
    view.dispose();
    vi.useRealTimers();
    rmSync(directory, { recursive: true });
  }
});

test("task menu confirms user kills and clears its footer", async () => {
  const stop = vi.fn(async () => task);
  const registry = {
    list: () => [task],
    get: () => task,
    stop,
  } as unknown as Registry;
  const select = vi
    .fn()
    .mockImplementationOnce(async (_title, labels: string[]) => labels[0])
    .mockResolvedValueOnce("Kill")
    .mockResolvedValueOnce(undefined);
  const harness = indicatorContext();
  harness.ui.select = select;
  const ctx = harness.ctx;
  const ui = new TaskUI(registry, ctx);
  await ui.show(ctx);
  expect(stop).toHaveBeenCalledWith("abc", "user");
  expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
  expect(harness.text()).toContain("Running: 1 ⏺ Finished: 0");
  ui.dispose();
  ui.dispose();
  expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pix-bg", undefined);
});

test("canceling confirmation leaves the task alone", async () => {
  const stop = vi.fn();
  const registry = {
    list: () => [task],
    get: () => task,
    stop,
  } as unknown as Registry;
  const ctx = {
    ui: {
      select: vi
        .fn()
        .mockImplementationOnce(async (_title, labels: string[]) => labels[0])
        .mockResolvedValueOnce("Kill")
        .mockResolvedValueOnce(undefined),
      confirm: vi.fn(async () => false),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
  const ui = new TaskUI(registry, ctx);
  await ui.show(ctx);
  expect(stop).not.toHaveBeenCalled();
  ui.dispose();
});
