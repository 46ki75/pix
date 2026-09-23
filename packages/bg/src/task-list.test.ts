import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import type { Outcome, Task } from "./registry.ts";
import { TaskListView } from "./ui.ts";

const task: Task = {
  id: "abc",
  name: "wide 界 task",
  command: "sleep 30",
  cwd: "/tmp",
  pid: 1,
  outputPath: "/missing",
  outputBytes: 0,
  startedAt: 0,
  status: "running",
};

function harness(initial: Task[] = [task]) {
  let tasks = initial;
  let rows = 20;
  const codes: Record<string, number> = {
    accent: 36,
    text: 37,
    muted: 90,
    success: 32,
    error: 31,
    warning: 33,
    dim: 2,
  };
  const theme = {
    fg: vi.fn<Theme["fg"]>(
      (color, text) => `\x1b[${codes[color] ?? 37}m${text}\x1b[39m`,
    ),
    getColorMode: vi.fn<Theme["getColorMode"]>(() => "truecolor"),
  };
  const done = vi.fn();
  const requestRender = vi.fn();
  const view = new TaskListView(
    () => tasks,
    theme,
    () => rows,
    requestRender,
    done,
  );
  return {
    view,
    theme,
    done,
    requestRender,
    tasks: (next: Task[]) => {
      tasks = next;
    },
    height: (next: number) => {
      rows = next;
    },
    text: (width = 120) =>
      stripVTControlCharacters(view.render(width).join("\n")),
    row: (id = "abc") =>
      view
        .render(120)
        .find((line) => stripVTControlCharacters(line).includes(`${id} |`)) ??
      "",
  };
}

const outcomes: [Outcome, number][] = [
  [{ kind: "exited", code: 0 }, 32],
  [{ kind: "exited", code: 3 }, 31],
  [{ kind: "signaled", signal: "SIGKILL", code: 137 }, 31],
  [{ kind: "failed", message: "I/O error" }, 31],
  [{ kind: "timed_out" }, 33],
  [{ kind: "output_capped" }, 33],
  [{ kind: "killed", by: "user" }, 90],
  [{ kind: "killed", by: "agent" }, 90],
  [{ kind: "killed", by: "shutdown" }, 90],
];

test.each(outcomes)(
  "task dot distinguishes finished outcome %j",
  (outcome, code) => {
    const h = harness([
      { ...task, status: "finished", endedAt: 2000, outcome },
    ]);
    expect(h.row()).toContain(`\x1b[${code}m⏺\x1b[39m`);
    // Resetting only the dot would otherwise lose the selected row's accent color.
    expect(h.row()).toContain("⏺\x1b[39m \x1b[36mabc |");
    expect(h.text()).toContain("| 2.0s");
  },
);

test("running and stopping dots match the footer blue, including the palette fallback", () => {
  const h = harness();
  expect(h.row()).toContain("\x1b[38;2;104;119;159m⏺\x1b[39m");
  h.tasks([
    { ...task, status: "stopping", outcome: { kind: "killed", by: "user" } },
  ]);
  expect(h.row()).toContain("\x1b[38;2;104;119;159m⏺\x1b[39m");
  h.theme.getColorMode.mockReturnValue("256color");
  expect(h.row()).toContain("\x1b[38;5;67m⏺\x1b[39m");
});

test("legend covers every color and uses the current theme on each render", () => {
  const h = harness([
    { ...task, status: "finished", outcome: { kind: "exited", code: 0 } },
  ]);
  const first = h.view.render(120).join("\n");
  for (const label of [
    "Legend:",
    "Running/stopping",
    "Succeeded",
    "Failed",
    "Timeout/cap",
    "Killed",
  ])
    expect(h.text()).toContain(label);
  for (const color of [
    "\x1b[38;2;104;119;159m",
    "\x1b[32m",
    "\x1b[31m",
    "\x1b[33m",
    "\x1b[90m",
  ])
    expect(first).toContain(`${color}⏺\x1b[39m`);
  h.theme.fg.mockImplementation((_color, text) => `\x1b[35m${text}\x1b[39m`);
  h.view.invalidate();
  const next = h.view.render(120).join("\n");
  expect(next).not.toBe(first);
  expect(h.row()).toContain("\x1b[35m⏺\x1b[39m \x1b[35mabc");
  expect(next).not.toContain("\x1b[32m");
});

test("live task changes retain selection by ID and preserve unselected text colors", () => {
  const h = harness([task, { ...task, id: "newer" }]);
  expect(h.text()).toContain("→ ⏺ newer |");
  expect(h.row()).toContain("⏺\x1b[39m \x1b[37mabc |");
  h.view.handleInput("\x1b[B");
  expect(h.text()).toContain("→ ⏺ abc |");
  h.tasks([
    { ...task, status: "finished", outcome: { kind: "exited", code: 3 } },
    { ...task, id: "newer" },
    { ...task, id: "newest" },
  ]);
  expect(h.text()).toContain("→ ⏺ abc |");
  expect(h.row()).toContain("\x1b[31m⏺");
  expect(h.row()).toContain("exit code 3");
  h.view.handleInput("\r");
  expect(h.done).toHaveBeenCalledExactlyOnceWith("abc");
  expect(h.requestRender).toHaveBeenCalled();
});

test("legend wraps and the task list remains bounded and navigable after resizing", () => {
  const h = harness(
    Array.from({ length: 40 }, (_, i) => ({ ...task, id: `task-${i}` })),
  );
  for (const width of [1, 12, 40, 80, 120]) {
    for (const rows of [1, 4, 10, 24]) {
      h.height(rows);
      const lines = h.view.render(width);
      expect(lines.length).toBeLessThanOrEqual(rows);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  }
  h.height(24);
  for (const label of [
    "Running/stopping",
    "Succeeded",
    "Failed",
    "Timeout/cap",
    "Killed",
  ])
    expect(h.text(40)).toContain(label);
  h.height(10);
  h.view.render(80);
  for (let i = 0; i < 35; i++) h.view.handleInput("j");
  expect(h.text(80)).toContain("→ ⏺ task-4 |");
  h.view.handleInput("k");
  expect(h.text(80)).toContain("→ ⏺ task-5 |");
  h.view.handleInput("\r");
  expect(h.done).toHaveBeenCalledExactlyOnceWith("task-5");
});

test.each(["\x1b", "\x03"])(
  "cancel %j resolves once and disposal ignores further input",
  (key) => {
    const h = harness();
    h.view.handleInput(key);
    expect(h.done).toHaveBeenCalledExactlyOnceWith(undefined);
    h.view.dispose();
    h.view.dispose();
    h.view.handleInput("\r");
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(h.view.render(120)).toEqual([]);
  },
);

test("task labels stay single-line and cannot inject terminal styling", () => {
  const h = harness([{ ...task, name: "\x1b[31munsafe\nname\x1b[0m" }]);
  expect(h.row()).not.toContain("\x1b[31m");
  expect(stripVTControlCharacters(h.row())).toContain("unsafe name");
});
