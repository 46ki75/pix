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

test("returns no styling for an empty segment list", () => {
  expect(powerline([])).toBe("");
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
