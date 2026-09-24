import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { ANSI, type AnsiColor } from "./ansi.ts";

const colors = [
  ["black", 30, 40],
  ["red", 31, 41],
  ["green", 32, 42],
  ["yellow", 33, 43],
  ["blue", 34, 44],
  ["magenta", 35, 45],
  ["cyan", 36, 46],
  ["white", 37, 47],
  ["brightBlack", 90, 100],
  ["brightRed", 91, 101],
  ["brightGreen", 92, 102],
  ["brightYellow", 93, 103],
  ["brightBlue", 94, 104],
  ["brightMagenta", 95, 105],
  ["brightCyan", 96, 106],
  ["brightWhite", 97, 107],
] as const satisfies readonly (readonly [AnsiColor, number, number])[];

test.each(colors)("maps %s foreground and background codes", (name, fg, bg) => {
  expect(ANSI.fg[name]).toBe(`\x1b[${fg}m`);
  expect(ANSI.bg[name]).toBe(`\x1b[${bg}m`);
});

test("provides all 16 colors and separate color and full resets", () => {
  const names = colors.map(([name]) => name);
  expect(Object.keys(ANSI.fg)).toEqual(names);
  expect(Object.keys(ANSI.bg)).toEqual(names);
  expect(ANSI.reset).toEqual({
    fg: "\x1b[39m",
    bg: "\x1b[49m",
    all: "\x1b[0m",
  });
});

test("colored text preserves terminal width and can be truncated by Pi", () => {
  const plain = " pix/作業";
  const colored = `${ANSI.bg.blue}${ANSI.fg.brightWhite}${plain}${ANSI.reset.fg}${ANSI.reset.bg}`;
  expect(visibleWidth(colored)).toBe(visibleWidth(plain));
  for (const width of [1, 2, 5, 10]) {
    expect(visibleWidth(truncateToWidth(colored, width))).toBeLessThanOrEqual(
      width,
    );
  }
});
