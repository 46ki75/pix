import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { ANSI } from "./ansi.ts";
import { POWERLINE, powerline } from "./powerline.ts";

test("uses rounded Powerline caps and an arrow separator", () => {
  expect(POWERLINE).toEqual({
    left: "\ue0b6",
    right: "\ue0b4",
    separator: "\ue0b0",
  });
});

test("renders a single segment with matching cap and background colors", () => {
  expect(powerline([{ text: " pix", background: "cyan" }])).toBe(
    "\x1b[49m\x1b[36m\x1b[46m\x1b[30m  pix \x1b[49m\x1b[36m\x1b[39m",
  );
});

test("accepts a custom foreground color", () => {
  expect(
    powerline([
      { text: "main", background: "blue", foreground: "brightWhite" },
    ]),
  ).toContain(`${ANSI.bg.blue}${ANSI.fg.brightWhite} main `);
});

test("connects segments using the previous background as the arrow foreground", () => {
  const result = powerline([
    { text: "model", background: "magenta" },
    { text: "high", background: "yellow", foreground: "red" },
    { text: " pix", background: "blue", foreground: "white" },
  ]);
  expect(stripVTControlCharacters(result)).toBe(" model  high   pix ");
  expect(result).toContain(
    `${ANSI.fg.magenta}${ANSI.bg.yellow}${ANSI.bg.yellow}${ANSI.fg.red} high `,
  );
  expect(result).toContain(
    `${ANSI.fg.yellow}${ANSI.bg.blue}${ANSI.bg.blue}${ANSI.fg.white}  pix `,
  );
  expect(
    result.endsWith(`${ANSI.reset.bg}${ANSI.fg.blue}${ANSI.reset.fg}`),
  ).toBe(true);
});

test("renders truecolor backgrounds with matching caps and transitions", () => {
  const result = powerline([
    { text: " pix", background: "#d9d3cc" },
    { text: " main", background: "#efecea" },
    { text: "", background: "#f7f5f4" },
  ]);
  expect(result).toBe(
    `${ANSI.reset.bg}\x1b[38;2;217;211;204m` +
      `\x1b[48;2;217;211;204m${ANSI.fg.black}  pix ` +
      "\x1b[38;2;217;211;204m\x1b[48;2;239;236;234m" +
      `\x1b[48;2;239;236;234m${ANSI.fg.black}  main ` +
      "\x1b[38;2;239;236;234m\x1b[48;2;247;245;244m" +
      `\x1b[48;2;247;245;244m${ANSI.fg.black}  ` +
      `${ANSI.reset.bg}\x1b[38;2;247;245;244m${ANSI.reset.fg}`,
  );
});

test("mixes truecolor and named foregrounds and backgrounds", () => {
  const result = powerline([
    { text: "one", background: "blue", foreground: "#abcdef" },
    { text: "two", background: "#d9d3cc", foreground: "brightWhite" },
  ]);
  expect(result).toContain(`${ANSI.bg.blue}\x1b[38;2;171;205;239m one `);
  expect(result).toContain(`${ANSI.fg.blue}\x1b[48;2;217;211;204m`);
  expect(result).toContain(`\x1b[48;2;217;211;204m${ANSI.fg.brightWhite} two `);
});

test("returns no styling for an empty segment list", () => {
  expect(powerline([])).toBe("");
  expect(powerline([], 80)).toBe("");
});

test.each([
  "main",
  "作業/🚀",
  "cafe\u0301",
  `${ANSI.fg.red}a${ANSI.reset.all}\r\nb\tc`,
])("fills the final segment's background before the right cap: %s", (text) => {
  const last = { text, background: "brightBlue" } as const;
  for (const segments of [
    [last],
    [{ text: " pix", background: "blue" } as const, last],
  ]) {
    const natural = powerline(segments);
    const naturalWidth = visibleWidth(natural);
    const cap = `${ANSI.reset.bg}${ANSI.fg.brightBlue}${ANSI.reset.fg}`;
    for (const width of [naturalWidth, naturalWidth + 1, 80, 40]) {
      const result = powerline(segments, width);
      const padding = " ".repeat(Math.max(0, width - naturalWidth));
      expect(result).toBe(natural.slice(0, -cap.length) + padding + cap);
      expect(visibleWidth(result)).toBe(Math.max(naturalWidth, width));
    }
  }
});

test("truncates an overflowing segment without losing its background or cap", () => {
  const expected = " direc... ";
  const result = powerline(
    [
      { text: "directory-that-does-not-fit", background: "blue" },
      { text: "main", background: "brightBlue" },
    ],
    visibleWidth(expected),
  );
  expect(stripVTControlCharacters(result)).toBe(expected);
  expect(result).toBe(
    `${ANSI.reset.bg}${ANSI.fg.blue}${ANSI.bg.blue}${ANSI.fg.black} direc... ${ANSI.reset.bg}${ANSI.fg.blue}${ANSI.reset.fg}`,
  );
});

test.each([
  [0, ""],
  [1, ""],
  [2, ""],
  [3, " "],
  [4, "  "],
  [5, " . "],
  [6, " .. "],
  [7, " ... "],
])("keeps rounded ends within %i columns", (width, expected) => {
  for (const background of ["blue", "#d9d3cc"] as const) {
    const result = powerline([{ text: "long-label", background }], width);
    expect(stripVTControlCharacters(result)).toBe(expected);
    expect(visibleWidth(result)).toBe(width);
  }
});

test.each([
  "作業/🚀".repeat(6),
  "cafe\u0301".repeat(8),
  `${ANSI.fg.red}long${ANSI.reset.all}\r\nlabel\tvalue`,
])("fits colored content and preserves caps across widths: %s", (text) => {
  for (const [first, last] of [
    ["blue", "brightBlue"],
    ["#d9d3cc", "#efecea"],
  ] as const) {
    const segments = [
      { text, background: first },
      { text: "main", background: last },
    ];
    for (let width = 2; width <= 80; width++) {
      const result = powerline(segments, width);
      const plain = stripVTControlCharacters(result);
      expect(visibleWidth(result)).toBe(width);
      expect(plain.startsWith("")).toBe(true);
      expect(plain.endsWith("")).toBe(true);
      expect(result).not.toContain(ANSI.reset.all);
      expect(result).not.toMatch(/[\r\n\t]/);
    }
  }
});

test("keeps padding and caps for an empty label", () => {
  expect(
    stripVTControlCharacters(powerline([{ text: "", background: "cyan" }])),
  ).toBe("  ");
});

test("removes embedded ANSI and flattens multiline labels", () => {
  const result = powerline([
    { text: `${ANSI.fg.red}a${ANSI.reset.all}\r\nb\tc\nd`, background: "cyan" },
  ]);
  expect(result).toBe(powerline([{ text: "a b c d", background: "cyan" }]));
});

test.each([" pix", "作業/🚀", "cafe\u0301"])(
  "measures and truncates a colored label with Pi helpers: %s",
  (text) => {
    const result = powerline([{ text, background: "brightBlue" }]);
    expect(visibleWidth(result)).toBe(visibleWidth(` ${text} `));
    for (const width of [1, 2, 3, 5, 10, 40]) {
      expect(visibleWidth(truncateToWidth(result, width))).toBeLessThanOrEqual(
        width,
      );
    }
  },
);
