import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import type { Task } from "./registry.ts";
import { OutputView } from "./ui.ts";

function output(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");
}

function harness(text = output(20), running = false) {
  const directory = mkdtempSync(join(tmpdir(), "pix-bg-output-"));
  const outputPath = join(directory, "output.log");
  writeFileSync(outputPath, text);
  let rows = 10;
  const task: Task = {
    id: "abc",
    name: "output test",
    command: "test",
    cwd: directory,
    pid: 1,
    outputPath,
    outputBytes: 0,
    startedAt: 0,
    status: running ? "running" : "finished",
  };
  if (!running) {
    task.outcome = { kind: "exited", code: 0 };
    task.endedAt = 1000;
  }
  const theme = {
    fg: vi.fn<Theme["fg"]>(
      (color, value) => `\x1b[${color === "border" ? 35 : 90}m${value}\x1b[39m`,
    ),
    getColorMode: vi.fn<Theme["getColorMode"]>(() => "truecolor"),
  };
  const view = new OutputView(
    () => task,
    theme,
    () => rows,
    vi.fn(),
    vi.fn(),
    new KeybindingsManager(TUI_KEYBINDINGS),
  );
  return {
    view,
    theme,
    task,
    lines: (width = 30) => view.render(width).map(stripVTControlCharacters),
    height: (next: number) => {
      rows = next;
    },
    write: (next: string) => writeFileSync(outputPath, next),
    dispose: () => {
      view.dispose();
      rmSync(directory, { recursive: true });
    },
  };
}

function moreRule(arrow: string, count: number): string {
  const label = ` ${arrow} ${count} more `;
  const left = Math.floor((30 - label.length) / 2);
  return "─".repeat(left) + label + "─".repeat(30 - left - label.length);
}

test("log view starts with a full-width separator above its header", () => {
  const h = harness();
  try {
    for (const width of [1, 12, 30, 80]) {
      const lines = h.lines(width);
      expect(lines[0]).toBe("─".repeat(width));
      expect(lines.length).toBeLessThanOrEqual(10);
      if (width >= 30) {
        expect(lines[1]).toContain(" abc ");
        expect(lines[2]).toContain("Last 8 KiB:");
        expect(lines[3]).toContain("↑");
      }
    }
  } finally {
    h.dispose();
  }
});

test("output dividers show centered counts of hidden rows in each direction", () => {
  const h = harness();
  const rule = "─".repeat(30);
  try {
    let lines = h.lines();
    expect(lines[3]).toBe("───────── ↑ 16 more ──────────");
    expect(lines.at(-2)).toBe(rule);
    expect(lines.slice(4, -2).map((line) => line.trimEnd())).toEqual(
      output(20).split("\n").slice(-4),
    );

    h.view.handleInput("\x1b[H");
    lines = h.lines();
    expect(lines[3]).toBe(rule);
    expect(lines[4]?.trimEnd()).toBe("line 0");
    expect(lines.at(-2)).toBe(moreRule("↓", 16));

    h.view.handleInput("\x1b[B");
    lines = h.lines();
    expect(lines[3]).toBe(moreRule("↑", 1));
    expect(lines.at(-2)).toBe(moreRule("↓", 15));

    h.view.handleInput("\x1b[F");
    lines = h.lines();
    expect(lines[3]).toBe(moreRule("↑", 16));
    expect(lines.at(-3)?.trimEnd()).toBe("line 19");
    expect(lines.at(-2)).toBe(rule);
  } finally {
    h.dispose();
  }
});

test("page navigation updates counts and clamps at the first and last page", () => {
  const h = harness();
  try {
    h.lines();
    for (const [key, above, below] of [
      ["\x1b[5~", 12, 4],
      ["\x1b[5~", 8, 8],
      ["\x1b[5~", 4, 12],
      ["\x1b[5~", 0, 16],
      ["\x1b[5~", 0, 16],
      ["\x1b[6~", 4, 12],
      ["\x1b[6~", 8, 8],
      ["\x1b[6~", 12, 4],
      ["\x1b[6~", 16, 0],
      ["\x1b[6~", 16, 0],
    ] as const) {
      h.view.handleInput(key);
      const lines = h.lines();
      expect(lines[3]).toBe(above ? moreRule("↑", above) : "─".repeat(30));
      expect(lines.at(-2)).toBe(below ? moreRule("↓", below) : "─".repeat(30));
      expect(lines[4]?.trimEnd()).toBe(`line ${above}`);
    }
  } finally {
    h.dispose();
  }
});

test("narrow dividers never show a partial multi-digit count", () => {
  const h = harness(output(120));
  try {
    expect(h.lines(30)[3]).toBe(moreRule("↑", 116));
    expect(h.lines(14)[3]).toBe("─ ↑ 116 more ─");
    expect(h.lines(9)[3]).toBe("─ ↑ 116 ─");
    expect(h.lines(8)[3]).toBe("── ↑ ───");
  } finally {
    h.dispose();
  }
});

test.each(["", "one line", output(4)])(
  "output that fits hides both counts and arrows: %j",
  (text) => {
    const h = harness(text);
    try {
      const lines = h.lines();
      expect(lines[3]).toBe("─".repeat(30));
      expect(lines.at(-2)).toBe("─".repeat(30));
      expect(lines.join("\n")).not.toMatch(/[↑↓]|more/);
      if (!text) expect(lines.join("\n")).toContain("(no output)");
    } finally {
      h.dispose();
    }
  },
);

test("output dividers fit narrow widths without truncating counts or hiding arrows", () => {
  const h = harness();
  try {
    for (const width of [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 30, 80]) {
      h.view.handleInput("\x1b[F");
      let lines = h.lines(width);
      expect(lines.length).toBeLessThanOrEqual(10);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines[0]).toBe("─".repeat(width));
      expect(visibleWidth(lines[3] ?? "")).toBe(width);
      expect(lines[3]?.match(/↑/g)).toHaveLength(1);
      if (width >= 13) expect(lines[3]).toContain(" ↑ 16 more ");
      else if (width >= 8) expect(lines[3]).toContain(" ↑ 16 ");
      else expect(lines[3]).not.toMatch(/\d/);
      expect(lines.at(-2)).toBe("─".repeat(width));
      h.view.handleInput("\x1b[H");
      lines = h.lines(width);
      expect(lines[3]).toBe("─".repeat(width));
      expect(visibleWidth(lines.at(-2) ?? "")).toBe(width);
      expect(lines.at(-2)?.match(/↓/g)).toHaveLength(1);
      if (width >= 13) expect(lines.at(-2)).toContain(" ↓ 16 more ");
      else if (width >= 8) expect(lines.at(-2)).toContain(" ↓ 16 ");
      else expect(lines.at(-2)).not.toMatch(/\d/);
    }
    expect(h.view.render(0)).toEqual([]);
  } finally {
    h.dispose();
  }
});

test("short viewports prioritize output while keeping paired dividers when possible", () => {
  const h = harness();
  try {
    for (const rows of [1, 2, 3, 4, 5, 6, 7, 8, 10]) {
      h.height(rows);
      h.view.handleInput("\x1b[F");
      let lines = h.lines();
      expect(lines.length).toBeLessThanOrEqual(rows);
      expect(lines.join("\n")).toContain("line 19");
      if (rows >= 5) expect(lines[0]).toBe("─".repeat(30));
      if (rows >= 3) {
        const borderIndex = rows >= 7 ? 3 : rows >= 5 ? 2 : 0;
        const outputRows = lines.filter((line) =>
          line.startsWith("line "),
        ).length;
        expect(lines[borderIndex]).toBe(moreRule("↑", 20 - outputRows));
        expect(lines.at(rows >= 6 ? -2 : -1)).toBe("─".repeat(30));
      }
      h.view.handleInput("\x1b[H");
      lines = h.lines();
      expect(lines.length).toBeLessThanOrEqual(rows);
      expect(lines.join("\n")).toContain("line 0");
    }
  } finally {
    h.dispose();
  }
});

test("counts reflect wrapped output after resizing", () => {
  const h = harness("abcdefghijklmnopqrstuvwxyz");
  try {
    expect(h.lines(80).join("\n")).not.toMatch(/[↑↓]/);
    h.height(7);
    expect(h.lines(13)[3]).toBe("─ ↑ 1 more ──");
    h.view.handleInput("\x1b[H");
    const narrow = h.lines(13);
    expect(narrow[3]).toBe("─".repeat(13));
    expect(narrow.at(-2)).toBe("─ ↓ 1 more ──");
    expect(h.lines(80).join("\n")).not.toMatch(/[↑↓]/);
  } finally {
    h.dispose();
  }
});

test("counts refresh as live output grows or shrinks without losing follow behavior", () => {
  vi.useFakeTimers();
  const h = harness(output(2), true);
  try {
    expect(h.lines().join("\n")).not.toMatch(/[↑↓]/);
    h.write(output(8));
    vi.advanceTimersByTime(1000);
    let lines = h.lines();
    expect(lines[3]).toBe(moreRule("↑", 4));
    expect(lines.at(-3)?.trimEnd()).toBe("line 7");
    expect(lines.at(-2)).toBe("─".repeat(30));
    h.view.handleInput("\x1b[H");
    h.write(output(10));
    vi.advanceTimersByTime(1000);
    lines = h.lines();
    expect(lines[3]).toBe("─".repeat(30));
    expect(lines[4]?.trimEnd()).toBe("line 0");
    expect(lines.at(-2)).toBe(moreRule("↓", 6));
    h.view.handleInput("\x1b[F");
    expect(h.lines().at(-3)?.trimEnd()).toBe("line 9");
    h.write(output(1));
    vi.advanceTimersByTime(1000);
    expect(h.lines().join("\n")).not.toMatch(/[↑↓]/);
  } finally {
    h.dispose();
    vi.useRealTimers();
  }
});

test("output header refreshes its status, elapsed time, and current theme", () => {
  vi.useFakeTimers();
  vi.setSystemTime(2000);
  const h = harness(output(2), true);
  try {
    expect(h.lines(120)[1]).toBe(" abc  output test running 󰔛 2.0s");
    expect(h.view.render(120)[1]).toContain("\x1b[38;2;104;119;159m\x1b[39m");
    h.theme.getColorMode.mockReturnValue("256color");
    vi.advanceTimersByTime(1000);
    expect(h.lines(120)[1]).toContain("󰔛 3.0s");
    expect(h.view.render(120)[1]).toContain("\x1b[38;5;67m\x1b[39m");
    h.task.status = "stopping";
    expect(h.lines(120)[1]).toContain("stopping 󰔛 3.0s");
    h.task.outcome = { kind: "killed", by: "user" };
    expect(h.lines(120)[1]).toBe(" abc  output test killed by user 󰔛 3.0s");
    h.task.status = "finished";
    h.task.endedAt = 3000;
    vi.advanceTimersByTime(1000);
    expect(h.lines(120)[1]).toBe(" abc  output test killed by user 󰔛 3.0s");
    h.theme.fg.mockImplementation(
      (_color, value) => `\x1b[36m${value}\x1b[39m`,
    );
    h.view.invalidate();
    expect(h.view.render(120)[1]).toContain("\x1b[36m\x1b[39m");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    h.dispose();
    vi.useRealTimers();
  }
});

test("output headers sanitize task names and error messages", () => {
  const h = harness();
  try {
    h.task.name = "\x1b[41munsafe\nname\x1b[0m";
    h.task.outcome = { kind: "failed", message: "\x1b[41mbad\nerror\x1b[0m" };
    expect(h.lines(120)[1]).toBe(
      " abc  unsafe name failed: bad error 󰔛 1.0s",
    );
    expect(h.view.render(120)[1]).not.toContain("\x1b[41m");
  } finally {
    h.dispose();
  }
});

test("output dividers and count labels use the current theme", () => {
  const h = harness();
  try {
    const first = h.view.render(30)[3];
    expect(first).toContain("\x1b[35m─────────\x1b[39m");
    expect(first).toContain("\x1b[90m ↑ 16 more \x1b[39m");
    h.theme.fg.mockImplementation(
      (_color, value) => `\x1b[36m${value}\x1b[39m`,
    );
    h.view.invalidate();
    const next = h.view.render(30)[3];
    expect(next).not.toBe(first);
    expect(next).toContain("\x1b[36m ↑ 16 more \x1b[39m");
    expect(stripVTControlCharacters(next ?? "")).toBe(moreRule("↑", 16));
  } finally {
    h.dispose();
  }
});
