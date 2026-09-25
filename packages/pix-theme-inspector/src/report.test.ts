import { Theme } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  Text,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { formatThemeReport } from "./report.ts";
import { TOKENS } from "./tokens.ts";

type Foreground = ConstructorParameters<typeof Theme>[0];
type Background = ConstructorParameters<typeof Theme>[1];
type Mode = ReturnType<Theme["getColorMode"]>;

function fixture(mode: Mode = "truecolor", name?: string): Theme {
  const foreground = Object.fromEntries(
    TOKENS.filter((token) => token.kind === "foreground").map((token) => [
      token.name,
      "#112233",
    ]),
  ) as Foreground;
  const background = Object.fromEntries(
    TOKENS.filter((token) => token.kind === "background").map((token) => [
      token.name,
      "#abcdef",
    ]),
  ) as Background;
  foreground.text = "#dddddd";
  foreground.dim = "#555555";
  foreground.userMessageText = "";
  foreground.warning = 3;
  background.userMessageBg = "";
  background.toolErrorBg = 124;
  delete foreground.scrollbarTrack;
  delete foreground.scrollbarThumb;
  delete foreground.searchMatchText;
  delete foreground.thinkingMax;
  delete background.searchMatchBg;
  return new Theme(
    foreground,
    background,
    mode,
    name === undefined ? {} : { name },
  );
}

function tokenRows(report: string): string[] {
  return stripTerminalSequences(report)
    .split("\n")
    .filter((line) =>
      TOKENS.some((token) => line.startsWith(`${token.name} `)),
    );
}

function plainRows(theme: Theme): Map<string, string> {
  return new Map(
    tokenRows(formatThemeReport(theme)).map((line) => [
      line.split(" ")[0] ?? "",
      line,
    ]),
  );
}

afterEach(() => vi.restoreAllMocks());

test.each(["truecolor", "256color"] as const)(
  "reports all tokens exactly once with %s effective values",
  (mode) => {
    const theme = fixture(mode, "test-theme");
    const report = stripTerminalSequences(formatThemeReport(theme));
    expect(report).toContain(`Theme: "test-theme" | ${mode} | 56 tokens`);
    const rows = plainRows(theme);
    expect(rows.size).toBe(56);
    expect(tokenRows(report)).toHaveLength(56);
    expect([...rows.keys()]).toEqual(TOKENS.map((token) => token.name));
    expect(rows.get("accent")).toMatch(
      mode === "truecolor" ? /#112233$/ : /index \d+$/,
    );
    expect(rows.get("toolSuccessBg")).toMatch(
      mode === "truecolor" ? /#abcdef$/ : /index \d+$/,
    );
    expect(rows.get("warning")).toMatch(/index 3$/);
    expect(rows.get("toolErrorBg")).toMatch(/index 124$/);
    expect(rows.get("userMessageText")).toMatch(/terminal default$/);
    expect(rows.get("userMessageBg")).toMatch(/terminal default$/);
    expect(rows.get("accent")).not.toContain("[");
    expect(report).not.toContain("█");
    expect(rows.get("selectedBg")).toContain("[    ]");
  },
);

test("resolves all five optional tokens through Pi's real Theme fallbacks", () => {
  const rows = plainRows(fixture());
  for (const [token, fallback] of [
    ["scrollbarTrack", "muted"],
    ["scrollbarThumb", "text"],
    ["searchMatchText", "text"],
    ["thinkingMax", "thinkingXhigh"],
    ["searchMatchBg", "selectedBg"],
  ] as const) {
    const value = rows
      .get(token)
      ?.match(/(#[\da-f]{6}|index \d+|terminal default)$/)?.[0];
    expect(value).toBeDefined();
    expect(rows.get(fallback)?.endsWith(`  ${value}`)).toBe(true);
  }
});

test("handles unnamed themes and escapes control characters in theme names", () => {
  expect(stripTerminalSequences(formatThemeReport(fixture()))).toContain(
    'Theme: "(unnamed)"',
  );
  const name = "theme\n\u001b[2J";
  const report = formatThemeReport(fixture("truecolor", name));
  expect(report).toContain(JSON.stringify(name));
  expect(report).not.toContain("\u001b[2J");
});

test("unknown color sequences are described but never replayed in labels or swatches", () => {
  const theme = fixture();
  const getFgAnsi = theme.getFgAnsi.bind(theme);
  const getBgAnsi = theme.getBgAnsi.bind(theme);
  vi.spyOn(theme, "getFgAnsi").mockImplementation((token) =>
    token === "accent" ? "\u001b[2J" : getFgAnsi(token),
  );
  vi.spyOn(theme, "getBgAnsi").mockImplementation((token) =>
    token === "selectedBg" ? "\u001b[0m" : getBgAnsi(token),
  );
  const fg = vi.spyOn(theme, "fg");
  const bg = vi.spyOn(theme, "bg");
  const report = formatThemeReport(theme);
  expect(report).not.toContain("\u001b[2J");
  expect(report).not.toContain("\u001b[0m");
  expect(
    plainRows(theme).get("accent")?.endsWith('  unknown "\\u001b[2J"'),
  ).toBe(true);
  expect(plainRows(theme).get("accent")).not.toContain("????");
  expect(stripTerminalSequences(report)).toContain(
    '[????]  unknown "\\u001b[0m"',
  );
  expect(fg.mock.calls.some(([color]) => color === "accent")).toBe(false);
  expect(bg).not.toHaveBeenCalledWith("selectedBg", "    ");
});

test.each(["truecolor", "256color"] as const)(
  "%s foreground names use their token colors while values and background labels stay readable",
  (mode) => {
    const theme = fixture(mode);
    const report = formatThemeReport(theme);
    for (const token of TOKENS) {
      const line = report
        .split("\n")
        .find((line) =>
          stripTerminalSequences(line).startsWith(`${token.name} `),
        );
      const nameColor = token.kind === "foreground" ? token.name : "text";
      expect(line?.startsWith(theme.getFgAnsi(nameColor) + token.name)).toBe(
        true,
      );
      expect(line?.endsWith(theme.getFgAnsi("dim"))).toBe(true);
      if (token.kind === "foreground") {
        expect(line).toContain(`\u001b[39m${theme.getFgAnsi("text")}  `);
        expect(line).not.toContain("█");
      } else {
        expect(line).toContain(
          `${theme.getBgAnsi(token.name)}    \u001b[49m${theme.getFgAnsi("text")}]`,
        );
      }
    }
  },
);

test.each([1, 2, 5, 24, 40, 80, 120])(
  "native notification wrapping preserves tokens at %i columns",
  (width) => {
    const theme = fixture();
    const text = new Text(theme.fg("dim", formatThemeReport(theme)), 1, 0);
    const lines = text.render(width);
    for (const line of lines)
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    const content = lines
      .map(stripTerminalSequences)
      .join("")
      .replace(/\s/g, "");
    for (const token of TOKENS) expect(content).toContain(token.name);
    // The same component must reflow when the terminal resizes, not keep prewrapped rows.
    const wider = text.render(120);
    expect(wider).toHaveLength(85);
    expect(lines.length).toBeGreaterThanOrEqual(wider.length);
  },
);
