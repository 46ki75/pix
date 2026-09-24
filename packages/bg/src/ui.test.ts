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
  const codes: Record<string, number> = {
    text: 37,
    muted: 90,
    success: 32,
    error: 31,
    warning: 33,
    dim: 2,
    borderMuted: 35,
  };
  const theme = {
    fg: vi.fn(
      (color: string, text: string) =>
        `\x1b[${codes[color] ?? 90}m${text}\x1b[39m`,
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
    custom: vi.fn(),
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

test("indicator appears on first task, counts stopping as running, and retains outcome totals", () => {
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
    { placement: "aboveEditor" },
  );
  expect(harness.text().split("\n")).toEqual([
    "──  Background Tasks ".padEnd(100, "─"),
    "  Running: 2  Succeeded: 1  Failed: 0  Timeout: 0  Killed: 0",
  ]);
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
  expect(harness.text().split("\n")[1]).toBe(
    "  Running: 0  Succeeded: 2  Failed: 0  Timeout: 0  Killed: 1",
  );
  expect(harness.ui.setWidget).toHaveBeenCalledTimes(1);
  expect(harness.requestRender).toHaveBeenCalled();
  ui.dispose();
  const calls = harness.ui.setWidget.mock.calls.length;
  ui.update();
  ui.dispose();
  expect(harness.ui.setWidget).toHaveBeenCalledTimes(calls);
  expect(harness.widget).toBeUndefined();
  // A fresh runtime does not show the indicator based on session history.
  const replacement = new TaskUI(
    { list: () => [] } as unknown as Registry,
    harness.ctx,
  );
  expect(harness.widget).toBeUndefined();
  replacement.dispose();
});

const outcomes: [Outcome, string][] = [
  [{ kind: "exited", code: 0 }, "Succeeded"],
  [{ kind: "exited", code: 3 }, "Failed"],
  [{ kind: "signaled", signal: "SIGKILL", code: 137 }, "Failed"],
  [{ kind: "timed_out" }, "Timeout"],
  [{ kind: "output_capped" }, "Timeout"],
  [{ kind: "failed", message: "I/O error" }, "Failed"],
  [{ kind: "killed", by: "agent" }, "Killed"],
  [{ kind: "killed", by: "user" }, "Killed"],
  [{ kind: "killed", by: "shutdown" }, "Killed"],
];
test.each(outcomes)(
  "indicator counts the correct category for finished outcome: %j",
  (outcome, label) => {
    const harness = indicatorContext();
    const ui = new TaskUI(
      {
        list: () => [{ ...task, status: "finished", outcome }],
      } as unknown as Registry,
      harness.ctx,
    );
    expect(harness.text()).toContain(`${label}: 1`);
    expect(harness.text().match(/: \d+/g)?.sort()).toEqual([
      ": 0",
      ": 0",
      ": 0",
      ": 0",
      ": 1",
    ]);
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
  expect(harness.ui.theme.fg).toHaveBeenCalledWith("muted", "");
  expect(harness.ui.theme.fg).toHaveBeenCalledWith("dim", "Background Tasks");
  expect(harness.ui.theme.fg).toHaveBeenCalledWith("borderMuted", "── ");
  expect(harness.ui.theme.fg).toHaveBeenCalledWith(
    "borderMuted",
    "─".repeat(100 - visibleWidth("──  Background Tasks ")),
  );
  expect(first).toContain(
    "\x1b[35m── \x1b[39m\x1b[90m\x1b[39m \x1b[2mBackground Tasks\x1b[39m ",
  );
  for (const [color, icon, label, count] of [
    ["\x1b[38;2;104;119;159m", "", "Running:", "1"],
    ["\x1b[32m", "", "Succeeded:", "0"],
    ["\x1b[31m", "", "Failed:", "0"],
    ["\x1b[33m", "", "Timeout:", "0"],
    ["\x1b[90m", "", "Killed:", "0"],
  ]) {
    expect(harness.ui.theme.fg).toHaveBeenCalledWith("dim", label);
    expect(harness.ui.theme.fg).toHaveBeenCalledWith("text", count);
    expect(first).toContain(
      `${color}${icon}\x1b[39m \x1b[2m${label}\x1b[39m \x1b[37m${count}\x1b[39m`,
    );
  }
  harness.ui.theme.fg.mockImplementation(
    (_color, text) => `\x1b[36m${text}\x1b[39m`,
  );
  harness.widget?.invalidate();
  expect(harness.widget?.render(100).join("")).toContain("\x1b[36m");
  expect(harness.widget?.render(100).join("")).not.toBe(first);
  harness.ui.theme.getColorMode.mockReturnValue("256color");
  expect(harness.widget?.render(100).join("")).toContain(
    "\x1b[38;5;67m\x1b[39m",
  );
  expect(harness.widget?.render(0)).toEqual([]);
  for (const width of [1, 12, 22, 40, 80, 120]) {
    const lines = harness.widget?.render(width) ?? [];
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(visibleWidth(lines[0] ?? "")).toBe(width);
    if (width >= 22) {
      expect(stripVTControlCharacters(lines[0] ?? "")).toBe(
        "──  Background Tasks ".padEnd(width, "─"),
      );
    }
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

test("disposing while the task list is open closes it and registry updates refresh its rows", async () => {
  const harness = indicatorContext();
  let current = task;
  let view: Component | undefined;
  harness.ui.custom.mockImplementation(
    (factory) =>
      new Promise((resolve) => {
        view = factory(
          { terminal: { rows: 24 }, requestRender: harness.requestRender },
          harness.ui.theme,
          {},
          resolve,
        );
      }),
  );
  const ui = new TaskUI(
    { list: () => [current] } as unknown as Registry,
    harness.ctx,
  );
  const showing = ui.show(harness.ctx);
  expect(
    stripVTControlCharacters(view?.render(120).join("\n") ?? ""),
  ).toContain(" Running  Succeeded  Failed  Timeout  Killed");
  current = {
    ...task,
    status: "finished",
    outcome: { kind: "exited", code: 3 },
  };
  ui.update();
  expect(harness.requestRender).toHaveBeenCalled();
  expect(
    stripVTControlCharacters(view?.render(120).join("\n") ?? ""),
  ).toContain("exit code 3");
  ui.dispose();
  await showing;
  expect(view?.render(120)).toEqual([]);
  expect(harness.ui.select).not.toHaveBeenCalled();
});

test("task menu confirms user kills and clears its indicator", async () => {
  const stop = vi.fn(async () => task);
  const registry = {
    list: () => [task],
    get: () => task,
    stop,
  } as unknown as Registry;
  const harness = indicatorContext();
  harness.ui.custom
    .mockResolvedValueOnce("abc")
    .mockResolvedValueOnce(undefined);
  harness.ui.select.mockResolvedValueOnce("Kill");
  const ctx = harness.ctx;
  const ui = new TaskUI(registry, ctx);
  await ui.show(ctx);
  expect(stop).toHaveBeenCalledWith("abc", "user");
  expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
  expect(harness.text().split("\n")[1]).toBe(
    "  Running: 1  Succeeded: 0  Failed: 0  Timeout: 0  Killed: 0",
  );
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
      custom: vi
        .fn()
        .mockResolvedValueOnce("abc")
        .mockResolvedValueOnce(undefined),
      select: vi.fn().mockResolvedValueOnce("Kill"),
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
