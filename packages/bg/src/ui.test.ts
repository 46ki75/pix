import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeybindingsConfig,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
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

const vimBindings: KeybindingsConfig = {
  "tui.select.up": ["up", "k"],
  "tui.select.down": ["down", "j"],
  "tui.select.confirm": ["enter", "l"],
  "tui.select.cancel": ["escape", "ctrl+c", "h", "q"],
};

function indicatorContext(bindings = vimBindings) {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
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
    keys,
    requestRender,
    get widget() {
      return widget;
    },
    text: () => stripVTControlCharacters(widget?.render(100).join("\n") ?? ""),
  };
}

function interact(
  harness: ReturnType<typeof indicatorContext>,
  inputs: string[][],
) {
  const screens: string[] = [];
  harness.ui.custom.mockImplementation(
    (factory) =>
      new Promise((resolve) => {
        const view = factory(
          { terminal: { rows: 24 }, requestRender: harness.requestRender },
          harness.ui.theme,
          harness.keys,
          resolve,
        );
        screens.push(stripVTControlCharacters(view.render(120).join("\n")));
        const keys = inputs.shift();
        if (!keys) throw new Error("Unexpected dialog");
        for (const key of keys) {
          view.handleInput(key);
          view.render(120);
        }
      }),
  );
  return screens;
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

test.each(["h", "q", "\x1b[104u", "\x1b[113u", "\x1b", "\x03"])(
  "viewer scrolls, refreshes, and closes once with %j",
  (back) => {
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
      { fg: (_color, text) => text, getColorMode: () => "truecolor" },
      () => 10,
      render,
      done,
      new KeybindingsManager(TUI_KEYBINDINGS, vimBindings),
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
      for (const [down, up] of [
        ["j", "k"],
        ["\x1b[106u", "\x1b[107u"],
      ] as const) {
        view.handleInput(down);
        expect(view.render(80)[4]?.trimEnd()).toBe("line 1 界");
        view.handleInput(up);
        expect(view.render(80)[4]?.trimEnd()).toBe("line 0 界");
      }
      expect(view.render(120).at(-1)).toBe(
        " up k down j scroll · pageUp pageDown page · home top · end follow · escape ctrl+c h q back",
      );
      view.handleInput("\x1b[F");
      writeFileSync(outputPath, "updated output");
      vi.advanceTimersByTime(1000);
      expect(view.render(80).join("\n")).toContain("updated output");
      view.handleInput(back);
      view.handleInput(back);
      expect(done).toHaveBeenCalledTimes(1);
      expect(view.render(80)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      const count = render.mock.calls.length;
      vi.advanceTimersByTime(2000);
      expect(render).toHaveBeenCalledTimes(count);
    } finally {
      view.dispose();
      vi.useRealTimers();
      rmSync(directory, { recursive: true });
    }
  },
);

test("viewer honors remapped and disabled scroll, jump, and cancel actions", () => {
  const directory = mkdtempSync(join(tmpdir(), "pix-bg-keys-"));
  const outputPath = join(directory, "output.log");
  writeFileSync(
    outputPath,
    Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"),
  );
  const bindings: KeybindingsConfig = {
    "tui.select.up": "w",
    "tui.select.down": "s",
    "tui.select.pageUp": "u",
    "tui.select.pageDown": "d",
    "tui.altScreen.top": "t",
    "tui.altScreen.bottom": "b",
    "tui.select.cancel": "x",
  };
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  const done = vi.fn();
  const view = new OutputView(
    () => ({ ...task, outputPath, status: "finished" }),
    { fg: (_color, text) => text, getColorMode: () => "truecolor" },
    () => 8,
    vi.fn(),
    done,
    keys,
  );
  try {
    expect(view.render(120).at(-1)).toBe(
      " w s scroll · u d page · t top · b follow · x back",
    );
    for (const key of [
      "j",
      "k",
      "h",
      "q",
      "\x1b[A",
      "\x1b[B",
      "\x1b[H",
      "\x1b[F",
      "\x1b[5~",
      "\x1b[6~",
      "\x1b",
      "\x03",
    ])
      view.handleInput(key);
    expect(done).not.toHaveBeenCalled();
    expect(view.render(120)[4]?.trimEnd()).toBe("line 18");
    for (const [key, line] of [
      ["t", 0],
      ["s", 1],
      ["w", 0],
      ["d", 2],
      ["u", 0],
      ["b", 18],
    ] as const) {
      view.handleInput(key);
      expect(view.render(120)[4]?.trimEnd()).toBe(`line ${line}`);
    }
    keys.setUserBindings(
      Object.fromEntries(Object.keys(bindings).map((action) => [action, []])),
    );
    view.invalidate();
    expect(view.render(120).at(-1)).toBe("");
    for (const key of [
      "w",
      "s",
      "u",
      "d",
      "t",
      "b",
      "x",
      "\x1b[H",
      "\x1b",
      "\x03",
    ])
      view.handleInput(key);
    expect(done).not.toHaveBeenCalled();
    expect(view.render(120)[4]?.trimEnd()).toBe("line 18");
    keys.setUserBindings({ "tui.select.cancel": "z" });
    expect(view.render(120).at(-1)).toContain(" z back");
    view.handleInput("z");
    expect(done).toHaveBeenCalledTimes(1);
  } finally {
    view.dispose();
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
          harness.keys,
          resolve,
        );
      }),
  );
  const ui = new TaskUI(
    { list: () => [current] } as unknown as Registry,
    harness.ctx,
  );
  const showing = ui.show(harness.ctx);
  const listText = stripVTControlCharacters(view?.render(120).join("\n") ?? "");
  expect(listText).toContain("Background tasks");
  expect(listText).not.toContain(" Running");
  expect(harness.text()).toContain(
    "  Running: 1  Succeeded: 0  Failed: 0  Timeout: 0  Killed: 0",
  );
  current = {
    ...task,
    status: "finished",
    outcome: { kind: "exited", code: 3 },
  };
  ui.update();
  expect(harness.requestRender).toHaveBeenCalled();
  expect(
    stripVTControlCharacters(view?.render(120).join("\n") ?? ""),
  ).toContain("󰐦 3");
  ui.dispose();
  await showing;
  expect(view?.render(120)).toEqual([]);
  expect(harness.ui.select).not.toHaveBeenCalled();
});

test("task action menu shows the compact summary instead of pipe-separated text", async () => {
  const current: Task = {
    ...task,
    id: "09e8a86e51e9",
    name: "checksum-check",
    status: "finished",
    endedAt: 0,
    outcome: { kind: "exited", code: 0 },
  };
  const harness = indicatorContext();
  const screens = interact(harness, [["l"], ["q"], ["q"]]);
  const ui = new TaskUI(
    { list: () => [current], get: () => current } as unknown as Registry,
    harness.ctx,
  );
  try {
    await ui.show(harness.ctx);
    expect(screens[1]?.split("\n")[1]).toBe(
      " 09e8a86e51e9  checksum-check 󰐦 0 󰔛 0.0s",
    );
    expect(screens[1]).toContain("→ View output");
    expect(screens[1]).not.toContain("Kill");
    expect(screens[2]).toContain("Background tasks");
    expect(harness.ui.theme.fg).toHaveBeenCalledWith("success", "");
  } finally {
    ui.dispose();
  }
});

test.each([
  ["j", "l", "q"],
  ["\x1b[106u", "\x1b[108u", "\x1b[113u"],
  ["\x1b[B", "\r", "\x1b"],
])(
  "task menu navigates with %j, confirms kills with %j, and cancels with %j",
  async (down, select, cancel) => {
    const stop = vi.fn(async () => task);
    const registry = {
      list: () => [task],
      get: () => task,
      stop,
    } as unknown as Registry;
    const harness = indicatorContext();
    const screens = interact(harness, [
      [select],
      [down, select],
      [down, select],
      [cancel],
    ]);
    const ctx = harness.ctx;
    const ui = new TaskUI(registry, ctx);
    await ui.show(ctx);
    expect(stop).toHaveBeenCalledWith("abc", "user");
    expect(screens[2]).toContain(
      "Kill background task?  abc  界 test running 󰔛",
    );
    expect(screens[2]).toContain("→ No");
    expect(harness.text().split("\n")[1]).toBe(
      "  Running: 1  Succeeded: 0  Failed: 0  Timeout: 0  Killed: 0",
    );
    ui.dispose();
    ui.dispose();
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pix-bg", undefined);
  },
);

test("task menus and confirmation use the injected bindings instead of literal keys", async () => {
  const harness = indicatorContext({
    "tui.select.up": "w",
    "tui.select.down": "s",
    "tui.select.confirm": "d",
    "tui.select.cancel": "a",
  });
  const unbound = ["j", "k", "l", "h", "q", "\r", "\x1b", "\x03"];
  const screens = interact(harness, [
    [...unbound, "d"],
    [...unbound, "s", "d"],
    [...unbound, "s", "d"],
    ["a"],
  ]);
  const stop = vi.fn(async () => task);
  const ui = new TaskUI(
    { list: () => [task], get: () => task, stop } as unknown as Registry,
    harness.ctx,
  );
  try {
    await ui.show(harness.ctx);
    expect(stop).toHaveBeenCalledExactlyOnceWith("abc", "user");
    expect(harness.ui.custom).toHaveBeenCalledTimes(4);
    expect(screens[0]).toContain(" w s navigate · d select · a cancel");
    expect(screens[1]).toContain(" w s navigate · d select · a back");
    expect(screens[2]).toContain(" w s navigate · d select · a back");
  } finally {
    ui.dispose();
  }
});

test("task menus refresh compact headers, preserve selection when resized, and close on disposal", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  let current: Task = {
    ...task,
    name: `\x1b[41m${"界🙂".repeat(40)}\x1b[0m\nname`,
  };
  const harness = indicatorContext();
  const terminal = { rows: 24 };
  let view: Component | undefined;
  harness.ui.custom.mockImplementation(
    (factory) =>
      new Promise((resolve) => {
        view = factory(
          { terminal, requestRender: harness.requestRender },
          harness.ui.theme,
          harness.keys,
          resolve,
        );
      }),
  );
  const ui = new TaskUI(
    { list: () => [current], get: () => current } as unknown as Registry,
    harness.ctx,
  );
  const showing = ui.show(harness.ctx);
  try {
    view?.handleInput?.("l");
    await Promise.resolve();
    expect(harness.ui.custom).toHaveBeenCalledTimes(2);
    const header = () => view?.render(120)[1] ?? "";
    expect(header()).toContain("\x1b[38;2;104;119;159m\x1b[39m");
    expect(stripVTControlCharacters(header())).toContain("running 󰔛 1.0s");
    now.mockReturnValue(2000);
    expect(stripVTControlCharacters(header())).toContain("running 󰔛 2.0s");
    view?.handleInput?.("j");
    for (const rows of [8, 12, 24]) {
      terminal.rows = rows;
      for (const width of [1, 12, 40, 80, 120]) {
        const lines = view?.render(width) ?? [];
        expect(lines.length).toBeLessThanOrEqual(rows - 4);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(lines.join("\n")).not.toContain("\x1b[41m");
        if (width >= 40) {
          const title = stripVTControlCharacters(lines[1] ?? "");
          expect(title).toContain(" abc ");
          expect(title).toContain("running 󰔛 2.0s");
        }
        if (width >= 12)
          expect(stripVTControlCharacters(lines.join("\n"))).toContain(
            "→ Kill",
          );
      }
    }
    current = {
      ...current,
      status: "finished",
      endedAt: 2000,
      outcome: { kind: "exited", code: 3 },
    };
    harness.requestRender.mockClear();
    ui.update();
    expect(harness.requestRender).toHaveBeenCalled();
    expect(header()).toContain("\x1b[31m\x1b[39m");
    expect(stripVTControlCharacters(header())).toContain("󰐦 3 󰔛 2.0s");
    harness.ui.theme.fg.mockImplementation(
      (_color, text) => `\x1b[36m${text}\x1b[39m`,
    );
    view?.invalidate();
    expect(header()).toContain("\x1b[36m\x1b[39m");
    expect(header()).not.toContain("\x1b[31m");
    harness.keys.setUserBindings({
      "tui.select.up": [],
      "tui.select.down": [],
      "tui.select.confirm": [],
      "tui.select.cancel": "x",
    });
    view?.invalidate();
    const text = stripVTControlCharacters(view?.render(120).join("\n") ?? "");
    expect(text).toContain(" x back");
    expect(text).not.toContain("navigate");
    expect(text).not.toContain("select");
    for (const key of ["j", "k", "l", "h", "q", "\r", "\x1b[B", "\x1b", "\x03"])
      view?.handleInput?.(key);
    expect(
      stripVTControlCharacters(view?.render(120).join("\n") ?? ""),
    ).toContain("→ Kill");
  } finally {
    now.mockRestore();
    ui.dispose();
    await showing;
  }
  expect(view?.render(120)).toEqual([]);
  view?.handleInput?.("l");
  expect(harness.ui.custom).toHaveBeenCalledTimes(2);
});

test.each(["h", "q", "l"])(
  "canceling confirmation with %j leaves the task alone",
  async (cancel) => {
    const stop = vi.fn();
    const registry = {
      list: () => [task],
      get: () => task,
      stop,
    } as unknown as Registry;
    const harness = indicatorContext();
    interact(harness, [["l"], ["j", "l"], [cancel], ["q"]]);
    const ui = new TaskUI(registry, harness.ctx);
    await ui.show(harness.ctx);
    expect(stop).not.toHaveBeenCalled();
    expect(harness.ui.custom).toHaveBeenCalledTimes(4);
    ui.dispose();
  },
);

test.each(["h", "q"])(
  "%j returns from task menus and output to the task list",
  async (back) => {
    const harness = indicatorContext();
    const screens = interact(harness, [
      ["l"],
      [back],
      ["l"],
      ["j", "k", "l"],
      [back],
      ["q"],
    ]);
    const ui = new TaskUI(
      { list: () => [task], get: () => task } as unknown as Registry,
      harness.ctx,
    );
    try {
      await ui.show(harness.ctx);
      expect(harness.ui.custom).toHaveBeenCalledTimes(6);
      expect(screens[1]).toContain("View output");
      expect(screens[1]).toContain(
        " up k down j navigate · enter l select · escape ctrl+c h q back",
      );
      expect(screens[2]).toContain("Background tasks");
      expect(screens[4]).toContain("Last 8 KiB:");
      expect(screens[5]).toContain("Background tasks");
    } finally {
      ui.dispose();
    }
  },
);
