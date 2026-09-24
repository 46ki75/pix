import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { ANSI, type AnsiColor, colorCode } from "./ansi.ts";

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
  expect(colorCode("fg", name)).toBe(ANSI.fg[name]);
  expect(colorCode("bg", name)).toBe(ANSI.bg[name]);
});

test.each([
  ["#d9d3cc", "217;211;204"],
  ["#efecea", "239;236;234"],
  ["#f7f5f4", "247;245;244"],
  ["#31353a", "49;53;58"],
  ["#393e46", "57;62;70"],
  ["#40444c", "64;68;76"],
  ["#cabfb2", "202;191;178"],
  ["#c6b5a2", "198;181;162"],
  ["#bda68b", "189;166;139"],
  ["#d7d9e1", "215;217;225"],
  ["#b0b5be", "176;181;190"],
  ["#949ba7", "148;155;167"],
  ["#Aa00Ff", "170;0;255"],
  ["#000000", "0;0;0"],
  ["#ffffff", "255;255;255"],
] as const)("renders %s as truecolor foreground and background", (hex, rgb) => {
  expect(colorCode("fg", hex)).toBe(`\x1b[38;2;${rgb}m`);
  expect(colorCode("bg", hex)).toBe(`\x1b[48;2;${rgb}m`);
});

test.each([
  "#fff",
  "#gggggg",
  "#1234567",
  "#12345g",
  "#123456\n",
  "#123456\x1b[0m",
] as const)("rejects invalid six-digit hex color %s", (hex) => {
  expect(() => colorCode("fg", hex)).toThrow("Invalid hex color");
  expect(() => colorCode("bg", hex)).toThrow("Invalid hex color");
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
