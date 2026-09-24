import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { outcomeText } from "./format.ts";
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

const outcomes: [Outcome, number, string][] = [
  [{ kind: "exited", code: 0 }, 32, ""],
  [{ kind: "exited", code: 3 }, 31, ""],
  [{ kind: "signaled", signal: "SIGKILL", code: 137 }, 31, ""],
  [{ kind: "failed", message: "I/O error" }, 31, ""],
  [{ kind: "timed_out" }, 33, ""],
  [{ kind: "output_capped" }, 33, ""],
  [{ kind: "killed", by: "user" }, 90, ""],
  [{ kind: "killed", by: "agent" }, 90, ""],
  [{ kind: "killed", by: "shutdown" }, 90, ""],
];

test.each(outcomes)(
  "task icon distinguishes finished outcome %j",
  (outcome, code, icon) => {
    const h = harness([
      { ...task, status: "finished", endedAt: 2000, outcome },
    ]);
    expect(h.row()).toContain(`\x1b[${code}m${icon}\x1b[39m`);
    // Resetting only the icon would otherwise lose the selected row's accent color.
    expect(h.row()).toContain(`${icon}\x1b[39m \x1b[36mabc |`);
    expect(h.text()).toContain("| 2.0s");
  },
);

test.each(outcomes)(
  "long names retain the detailed outcome at 80 columns: %j",
  (outcome) => {
    for (const name of ["x".repeat(80), "界".repeat(80), "🙂".repeat(40)]) {
      const ids = ["112233445566", "66778899aabb"];
      const h = harness(
        ids.map((id) => ({
          ...task,
          id,
          name,
          status: "finished",
          endedAt: 2000,
          outcome,
        })),
      );
      const lines = h.view.render(80);
      for (const id of ids) {
        const row = lines
          .map(stripVTControlCharacters)
          .find((line) => line.includes(`${id} |`));
        expect(row).toContain(outcomeText(outcome));
        expect(row).toContain("| 2.0s");
        expect(row).not.toContain(name);
      }
      expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(20);
    }
  },
);

test("running and stopping icons match the footer blue, including the palette fallback", () => {
  const h = harness();
  expect(h.row()).toContain("\x1b[38;2;104;119;159m\x1b[39m");
  h.tasks([
    { ...task, status: "stopping", outcome: { kind: "killed", by: "user" } },
  ]);
  expect(h.row()).toContain("\x1b[38;2;104;119;159m\x1b[39m");
  h.theme.getColorMode.mockReturnValue("256color");
  expect(h.row()).toContain("\x1b[38;5;67m\x1b[39m");
});

test("top and bottom borders follow the viewport width and current theme without crowding out tasks", () => {
  const h = harness();
  for (const width of [1, 12, 40, 120]) {
    for (const rows of [4, 10, 24]) {
      h.height(rows);
      const lines = h.view.render(width);
      expect(stripVTControlCharacters(lines[0] ?? "")).toBe("─".repeat(width));
      expect(stripVTControlCharacters(lines.at(-1) ?? "")).toBe(
        "─".repeat(width),
      );
      expect(lines.length).toBeLessThanOrEqual(rows);
      expect(h.theme.fg).toHaveBeenCalledWith("border", "─".repeat(width));
    }
  }
  h.theme.fg.mockImplementation((_color, text) => `\x1b[35m${text}\x1b[39m`);
  h.view.invalidate();
  const lines = h.view.render(40);
  expect(lines[0]).toBe(`\x1b[35m${"─".repeat(40)}\x1b[39m`);
  expect(lines.at(-1)).toBe(lines[0]);
  // Keep the selected task visible even when little room remains for borders.
  for (const rows of [3, 4, 6, 8, 9, 10]) {
    h.height(rows);
    expect(h.text()).toContain("→  abc |");
  }
});

test.each([1, 40])(
  "task list separates and indents its legend and navigation hint (%i tasks)",
  (count) => {
    const h = harness(
      Array.from({ length: count }, (_, i) => ({ ...task, id: `task-${i}` })),
    );
    for (const width of [40, 120]) {
      for (const rows of [12, 24]) {
        h.height(rows);
        const lines = h.view.render(width).map(stripVTControlCharacters);
        const title = lines.indexOf("Background tasks");
        const legend = lines.findIndex((line) => line.startsWith("  Running"));
        const hint = lines.findIndex((line) => line.startsWith(" ↑↓"));
        expect(lines[title + 1]).toBe("");
        expect(lines[title + 2]).toContain(" task-");
        expect(legend).toBeGreaterThan(title + 2);
        expect(lines[legend - 1]).toBe("");
        expect(lines[legend - 2]).not.toBe("");
        expect(hint).toBeGreaterThan(legend + 1);
        expect(lines[hint - 1]).toBe("");
        expect(lines[hint - 2]).not.toBe("");
        expect(
          lines.slice(legend, hint - 1).every((line) => line.startsWith(" ")),
        ).toBe(true);
        expect(lines.filter((line) => line === "")).toHaveLength(3);
        expect(lines.length).toBeLessThanOrEqual(rows);
      }
    }
  },
);

test("navigation hint uses muted keys and dim separators and action labels", () => {
  const h = harness();
  const hint =
    h.view
      .render(120)
      .find((line) => stripVTControlCharacters(line).startsWith(" ↑↓")) ?? "";
  expect(stripVTControlCharacters(hint)).toBe(
    " ↑↓ / j k navigate · enter select · esc/ctrl+c cancel",
  );
  for (const key of ["↑↓", "j k", "enter", "esc", "ctrl+c"])
    expect(hint).toContain(`\x1b[90m${key}\x1b[39m`);
  for (const label of ["/", "navigate", "select", "cancel"])
    expect(hint).toContain(`\x1b[2m${label}\x1b[39m`);
  expect(hint.split("\x1b[2m/\x1b[39m")).toHaveLength(3);
});

test("legend covers every icon and color and uses the current theme on each render", () => {
  const h = harness([
    { ...task, status: "finished", outcome: { kind: "exited", code: 0 } },
  ]);
  const first = h.view.render(120).join("\n");
  expect(h.text().split("\n")).toContain(
    "  Running  Succeeded  Failed  Timeout  Killed",
  );
  for (const [color, icon, label] of [
    ["\x1b[38;2;104;119;159m", "", "Running"],
    ["\x1b[32m", "", "Succeeded"],
    ["\x1b[31m", "", "Failed"],
    ["\x1b[33m", "", "Timeout"],
    ["\x1b[90m", "", "Killed"],
  ]) {
    expect(h.theme.fg).toHaveBeenCalledWith("text", label);
    expect(first).toContain(`${color}${icon}\x1b[39m \x1b[37m${label}\x1b[39m`);
  }
  h.theme.fg.mockImplementation((_color, text) => `\x1b[35m${text}\x1b[39m`);
  h.view.invalidate();
  const next = h.view.render(120).join("\n");
  expect(next).not.toBe(first);
  expect(h.row()).toContain("\x1b[35m\x1b[39m \x1b[35mabc");
  expect(next).not.toContain("\x1b[32m");
});

test("live task changes retain selection by ID and preserve unselected text colors", () => {
  const h = harness([task, { ...task, id: "newer" }]);
  expect(h.text()).toContain("→  newer |");
  expect(h.row()).toContain("\x1b[39m \x1b[37mabc |");
  h.view.handleInput("\x1b[B");
  expect(h.text()).toContain("→  abc |");
  h.tasks([
    { ...task, status: "finished", outcome: { kind: "exited", code: 3 } },
    { ...task, id: "newer" },
    { ...task, id: "newest" },
  ]);
  expect(h.text()).toContain("→  abc |");
  expect(h.row()).toContain("\x1b[31m");
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
    for (const rows of [1, 4, 6, 8, 9, 10, 12, 24]) {
      h.height(rows);
      const lines = h.view.render(width);
      expect(lines.length).toBeLessThanOrEqual(rows);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  }
  h.height(24);
  for (const label of [
    " Running",
    " Succeeded",
    " Failed",
    " Timeout",
    " Killed",
  ])
    expect(h.text(40).replace(/\s+/g, " ")).toContain(label);
  h.height(10);
  h.view.render(80);
  for (let i = 0; i < 35; i++) h.view.handleInput("j");
  expect(h.text(80)).toContain("→  task-4 |");
  h.view.handleInput("k");
  expect(h.text(80)).toContain("→  task-5 |");
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
