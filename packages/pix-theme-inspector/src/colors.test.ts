import { expect, test } from "vitest";
import { describeColor, inspectColor } from "./colors.ts";

const ESC = "\u001b[";

test.each(["foreground", "background"] as const)(
  "inspects %s output without guessing RGB for indexed/default colors",
  (kind) => {
    const prefix = kind === "foreground" ? 38 : 48;
    expect(inspectColor(`${ESC}${prefix};2;0;128;255m`, kind)).toEqual({
      kind: "rgb",
      hex: "#0080ff",
    });
    expect(inspectColor(`${ESC}${prefix};5;0m`, kind)).toEqual({
      kind: "indexed",
      index: 0,
    });
    expect(inspectColor(`${ESC}${prefix};5;255m`, kind)).toEqual({
      kind: "indexed",
      index: 255,
    });
    expect(inspectColor(`${ESC}${prefix + 1}m`, kind)).toEqual({
      kind: "default",
    });
  },
);

test.each([
  "",
  "#ffffff",
  `${ESC}31m`,
  `${ESC}0m`,
  `${ESC}38;5;256m`,
  `${ESC}38;5;-1m`,
  `${ESC}38;5;1.5m`,
  `${ESC}38;5;1;2m`,
  `${ESC}38;2;1;2m`,
  `${ESC}38;2;1;2;3;4m`,
  `${ESC}38;2;1;2;999m`,
  `${ESC}38;2;1;;3m`,
  `${ESC}48;5;1m`,
  `${ESC}49m`,
  `${ESC}38;5;1m${ESC}0m`,
  `${ESC}38;5;1m\n`,
  `${ESC}2J`,
])(
  "preserves unrecognized foreground sequence %j as escaped diagnostics",
  (ansi) => {
    const color = inspectColor(ansi, "foreground");
    expect(color).toEqual({ kind: "unknown", ansi });
    expect(describeColor(color)).toBe(`unknown ${JSON.stringify(ansi)}`);
    expect(describeColor(color)).not.toContain("\u001b");
  },
);

test("rejects foreground sequences for a background token", () => {
  expect(inspectColor(`${ESC}38;2;1;2;3m`, "background").kind).toBe("unknown");
  expect(inspectColor(`${ESC}39m`, "background").kind).toBe("unknown");
});

test("formats the effective color representation", () => {
  expect(describeColor({ kind: "rgb", hex: "#123456" })).toBe("#123456");
  expect(describeColor({ kind: "indexed", index: 7 })).toBe("index 7");
  expect(describeColor({ kind: "default" })).toBe("terminal default");
});
