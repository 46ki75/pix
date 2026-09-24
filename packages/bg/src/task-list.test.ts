import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type KeybindingsConfig,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import type { Outcome, Task } from "./registry.ts";
import { OutputView, TaskListView } from "./ui.ts";

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

const vimBindings: KeybindingsConfig = {
  "tui.select.up": ["up", "k"],
  "tui.select.down": ["down", "j"],
  "tui.select.confirm": ["enter", "l"],
  "tui.select.cancel": ["escape", "ctrl+c", "h", "q"],
};

function harness(initial: Task[] = [task], bindings = vimBindings) {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
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
    keys,
  );
  return {
    view,
    keys,
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
        .find((line) => stripVTControlCharacters(line).includes(`${id} `)) ??
      "",
  };
}

test("task rows and output headers match the compact format", () => {
  const current: Task = {
    ...task,
    id: "434c3aa0b5e2",
    name: "100-line output test",
    status: "finished",
    endedAt: 0,
    outcome: { kind: "exited", code: 0 },
  };
  const h = harness([current]);
  const viewer = new OutputView(
    () => current,
    h.theme,
    () => 20,
    vi.fn(),
    vi.fn(),
    h.keys,
  );
  try {
    const expected = " 434c3aa0b5e2  100-line output test  0 󰔛 0.0s";
    expect.soft(h.text()).toContain(`→ ${expected}`);
    expect
      .soft(stripVTControlCharacters(viewer.render(120)[1] ?? ""))
      .toBe(expected);
  } finally {
    viewer.dispose();
  }
});

const outcomes: [Outcome, number, string, string][] = [
  [{ kind: "exited", code: 0 }, 32, "", " 0"],
  [{ kind: "exited", code: 3 }, 31, "", " 3"],
  [
    { kind: "signaled", signal: "SIGKILL", code: 137 },
    31,
    "",
    " 137 (SIGKILL)",
  ],
  [{ kind: "failed", message: "I/O error" }, 31, "", "failed: I/O error"],
  [{ kind: "timed_out" }, 33, "", "timed out"],
  [{ kind: "output_capped" }, 33, "", "output cap reached"],
  [{ kind: "killed", by: "user" }, 90, "", "killed by user"],
  [{ kind: "killed", by: "agent" }, 90, "", "killed by agent"],
  [{ kind: "killed", by: "shutdown" }, 90, "", "killed by shutdown"],
];

test.each(outcomes)(
  "task rows and output headers distinguish finished outcome %j",
  (outcome, code, icon, result) => {
    const current: Task = {
      ...task,
      status: "finished",
      endedAt: 2000,
      outcome,
    };
    const h = harness([current]);
    const viewer = new OutputView(
      () => current,
      h.theme,
      () => 20,
      vi.fn(),
      vi.fn(),
      h.keys,
    );
    try {
      for (const line of [h.row(), viewer.render(120)[1] ?? ""]) {
        expect(line).toContain(`\x1b[${code}m${icon}\x1b[39m`);
        // Resetting only the icon would otherwise lose the text's accent color.
        expect(line).toContain(`${icon}\x1b[39m \x1b[36mabc `);
        expect(stripVTControlCharacters(line)).toContain(
          `${icon} abc  wide 界 task ${result} 󰔛 2.0s`,
        );
      }
    } finally {
      viewer.dispose();
    }
  },
);

test.each(outcomes)(
  "long names retain the detailed outcome in both views at 80 columns: %j",
  (outcome, _code, _icon, result) => {
    for (const name of ["x".repeat(80), "界".repeat(80), "🙂".repeat(40)]) {
      const ids = ["112233445566", "66778899aabb"];
      const tasks: Task[] = ids.map((id) => ({
        ...task,
        id,
        name,
        status: "finished",
        endedAt: 2000,
        outcome,
      }));
      const h = harness(tasks);
      const lines = h.view.render(80);
      for (const current of tasks) {
        const viewer = new OutputView(
          () => current,
          h.theme,
          () => 20,
          vi.fn(),
          vi.fn(),
          h.keys,
        );
        try {
          const row = lines
            .map(stripVTControlCharacters)
            .find((line) => line.includes(`${current.id} `));
          const header = stripVTControlCharacters(viewer.render(80)[1] ?? "");
          for (const line of [row, header]) {
            expect(line).toContain(result);
            expect(line).toContain("󰔛 2.0s");
            expect(line).not.toContain(name);
          }
          expect(visibleWidth(header)).toBeLessThanOrEqual(80);
        } finally {
          viewer.dispose();
        }
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
    expect(h.text()).toContain("→  abc ");
  }
});

test.each([1, 40])(
  "task list has one blank row above and below its tasks and an indented hint (%i tasks)",
  (count) => {
    const h = harness(
      Array.from({ length: count }, (_, i) => ({ ...task, id: `task-${i}` })),
    );
    for (const width of [40, 120]) {
      for (const rows of [12, 24]) {
        h.height(rows);
        const lines = h.view.render(width).map(stripVTControlCharacters);
        const title = lines.indexOf("Background tasks");
        const hint = lines.findIndex((line) => line.startsWith(" up k down j"));
        expect(lines[title + 1]).toBe("");
        expect(lines[title + 2]).toContain(" task-");
        expect(hint).toBeGreaterThan(title + 2);
        expect(lines[hint - 1]).toBe("");
        expect(lines[hint - 2]).not.toBe("");
        expect(lines.filter((line) => line === "")).toHaveLength(2);
        expect(lines.filter((line) => line.includes(" task-"))).toHaveLength(
          Math.min(count, rows - 7),
        );
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
      .find((line) =>
        stripVTControlCharacters(line).startsWith(" up k down j"),
      ) ?? "";
  expect(stripVTControlCharacters(hint)).toBe(
    " up k down j navigate · enter l select · escape ctrl+c h q cancel",
  );
  for (const key of ["up k down j", "enter l", "escape ctrl+c h q"])
    expect(hint).toContain(`\x1b[90m${key}\x1b[39m`);
  for (const label of ["navigate", "select", "cancel"])
    expect(hint).toContain(`\x1b[2m${label}\x1b[39m`);
});

test("task list omits the duplicate legend and uses the current theme for task icons", () => {
  const h = harness([
    { ...task, status: "finished", outcome: { kind: "exited", code: 0 } },
  ]);
  const first = h.view.render(120).join("\n");
  for (const label of ["Running", "Succeeded", "Failed", "Timeout", "Killed"])
    expect(h.text()).not.toContain(label);
  expect(h.row()).toContain("\x1b[32m\x1b[39m");
  h.theme.fg.mockImplementation((_color, text) => `\x1b[35m${text}\x1b[39m`);
  h.view.invalidate();
  const next = h.view.render(120).join("\n");
  expect(next).not.toBe(first);
  expect(h.row()).toContain("\x1b[35m\x1b[39m \x1b[35mabc");
  expect(next).not.toContain("\x1b[32m");
});

test("live task changes retain selection by ID and preserve unselected text colors", () => {
  const h = harness([task, { ...task, id: "newer" }]);
  expect(h.text()).toContain("→  newer ");
  expect(h.row()).toContain("\x1b[39m \x1b[37mabc ");
  h.view.handleInput("\x1b[B");
  expect(h.text()).toContain("→  abc ");
  h.tasks([
    { ...task, status: "finished", outcome: { kind: "exited", code: 3 } },
    { ...task, id: "newer" },
    { ...task, id: "newest" },
  ]);
  expect(h.text()).toContain("→  abc ");
  expect(h.row()).toContain("\x1b[31m");
  expect(h.row()).toContain(" 3");
  h.view.handleInput("\r");
  expect(h.done).toHaveBeenCalledExactlyOnceWith("abc");
  expect(h.requestRender).toHaveBeenCalled();
});

test("task list remains bounded and navigable after resizing", () => {
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
  h.height(10);
  h.view.render(80);
  for (let i = 0; i < 35; i++) h.view.handleInput("j");
  expect(h.text(80)).toContain("→  task-4 ");
  h.view.handleInput("k");
  expect(h.text(80)).toContain("→  task-5 ");
  h.view.handleInput("\r");
  expect(h.done).toHaveBeenCalledExactlyOnceWith("task-5");
});

test.each(["h", "q", "\x1b[104u", "\x1b[113u", "\x1b", "\x03"])(
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

test.each([
  ["j", "k", "l"],
  ["\x1b[106u", "\x1b[107u", "\x1b[108u"],
])("navigate and select with %j / %j / %j", (down, up, select) => {
  const h = harness([task, { ...task, id: "newer" }]);
  h.view.handleInput(down);
  expect(h.text()).toContain("→  abc ");
  h.view.handleInput(up);
  expect(h.text()).toContain("→  newer ");
  h.view.handleInput(select);
  expect(h.done).toHaveBeenCalledExactlyOnceWith("newer");
  h.view.handleInput(select);
  expect(h.done).toHaveBeenCalledTimes(1);
});

test("task list follows injected semantic bindings and updates its hints", () => {
  const h = harness([task, { ...task, id: "newer" }], {
    "tui.select.up": "w",
    "tui.select.down": "s",
    "tui.select.confirm": "d",
    "tui.select.cancel": "a",
  });
  expect(h.text()).toContain(" w s navigate · d select · a cancel");
  for (const key of ["j", "k", "l", "h", "q", "\x1b[B", "\r", "\x1b", "\x03"])
    h.view.handleInput(key);
  expect(h.text()).toContain("→  newer ");
  expect(h.done).not.toHaveBeenCalled();
  h.view.handleInput("s");
  expect(h.text()).toContain("→  abc ");
  h.view.handleInput("w");
  expect(h.text()).toContain("→  newer ");

  h.keys.setUserBindings({
    "tui.select.up": [],
    "tui.select.down": [],
    "tui.select.confirm": "f",
    "tui.select.cancel": [],
  });
  h.view.invalidate();
  expect(h.text()).toContain(" f select");
  expect(h.text()).not.toContain("navigate");
  expect(h.text()).not.toContain("cancel");
  for (const key of [
    "s",
    "w",
    "d",
    "a",
    "j",
    "k",
    "l",
    "h",
    "q",
    "\r",
    "\x1b[B",
    "\x1b",
  ])
    h.view.handleInput(key);
  expect(h.done).not.toHaveBeenCalled();
  expect(h.text()).toContain("→  newer ");
  h.view.handleInput("f");
  expect(h.done).toHaveBeenCalledExactlyOnceWith("newer");
});

test("task list uses Pi defaults without implicit letter aliases", () => {
  const h = harness([task, { ...task, id: "newer" }], {});
  expect(h.text()).toContain(
    " up down navigate · enter select · escape ctrl+c cancel",
  );
  for (const key of ["j", "k", "l", "h", "q"]) h.view.handleInput(key);
  expect(h.done).not.toHaveBeenCalled();
  expect(h.text()).toContain("→  newer ");
  h.view.handleInput("\x1b[B");
  expect(h.text()).toContain("→  abc ");
  h.view.handleInput("\r");
  expect(h.done).toHaveBeenCalledExactlyOnceWith("abc");
});

test("task labels stay single-line and cannot inject terminal styling", () => {
  const h = harness([{ ...task, name: "\x1b[31munsafe\nname\x1b[0m" }]);
  expect(h.row()).not.toContain("\x1b[31m");
  expect(stripVTControlCharacters(h.row())).toContain("unsafe name");
});
