import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import type { UsageProvider, UsageWindow } from "./types.ts";
import { renderUsageWidget, type UsageWidgetState } from "./widget.ts";

const NOW = Date.parse("2026-09-25T00:00:00.000Z");
const RESET = "\x1b[39m";
const colors = {
  accent: "\x1b[36m",
  borderMuted: "\x1b[34m",
  muted: "\x1b[90m",
  dim: "\x1b[38;5;8m",
  text: "\x1b[37m",
  warning: "\x1b[33m",
  error: "\x1b[31m",
};

function makeTheme(override?: string) {
  const ansi = (color: Parameters<Theme["fg"]>[0]) =>
    override ?? colors[color as keyof typeof colors] ?? "\x1b[39m";
  return {
    fg: vi.fn<Theme["fg"]>((color, text) => `${ansi(color)}${text}${RESET}`),
    getFgAnsi: vi.fn<Theme["getFgAnsi"]>(ansi),
  };
}

function window(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    id: "primary_window",
    label: "Weekly",
    usedPercent: 93,
    resetsAt: new Date(NOW + (3 * 1440 + 9 * 60 + 47) * 60_000).toISOString(),
    windowSeconds: 604800,
    ...overrides,
  };
}

function success(
  provider: UsageProvider = "codex",
  windows: UsageWindow[] = [window()],
): UsageWidgetState {
  return {
    provider,
    status: "ok",
    usage: {
      provider,
      fetchedAt: new Date(NOW - 60_000).toISOString(),
      windows,
    },
  };
}

function plain(state: UsageWidgetState, now = NOW): string[] {
  return renderUsageWidget(state, 120, makeTheme(), now).map(
    stripVTControlCharacters,
  );
}

afterEach(() => vi.restoreAllMocks());

test.each([
  ["claude", " Claude"],
  ["codex", " Codex"],
] as const)(
  "renders one compact %s row per reported window",
  (provider, name) => {
    const rows = plain(
      success(provider, [
        window(),
        window({
          id: "secondary_window",
          label: "5-hour",
          windowSeconds: 18000,
          usedPercent: 12.34,
          resetsAt: new Date(NOW + 135 * 60_000).toISOString(),
        }),
      ]),
    );
    expect(rows).toEqual([
      `── 󱘖 Usage ${"─".repeat(109)}`,
      `${name} 󱛡 Weekly 󰓅  93%  3d  9h 47m 2026-09-28 09:47:00 (UTC)`,
      `${name}  5-hour 󰓅 12.3%  2h 15m 2026-09-25 02:15:00 (UTC)`,
    ]);
    expect(rows.join("\n")).not.toMatch(/checked|fetched/i);
  },
);

test.each([
  [18000, "5-hour", " "],
  [604800, "Weekly", "󱛡 "],
  [604800, "Sonnet weekly", "󱛡 "],
  [604800, "Opus weekly", "󱛡 "],
  [900, "15-minute", ""],
  [null, "Primary", ""],
  [900, "Weekly", ""],
] as const)(
  "chooses window icons by duration (%s seconds), not position or label",
  (windowSeconds, label, icon) => {
    expect(plain(success("codex", [window({ windowSeconds, label })]))[1]).toBe(
      ` Codex ${icon}${label} 󰓅  93%  3d  9h 47m 2026-09-28 09:47:00 (UTC)`,
    );
  },
);

test.each([
  [null, "-d --h --m"],
  [1, "<1m"],
  [59_999, "<1m"],
  [60_000, "1m"],
  [3_599_999, "59m"],
  [3_600_000, "1h"],
  [61 * 60_000, "1h  1m"],
  [86_400_000, "1d"],
  [7 * 86_400_000, "7d"],
  [(12 * 1440 + 14 * 60 + 8) * 60_000, "12d 14h  8m"],
  [0, "now"],
  [-1, "<1m ago"],
  [-60_000, "1m ago"],
  [-3_600_000, "1h ago"],
  [-(4 * 1440 + 14 * 60 + 8) * 60_000, "4d 14h  8m ago"],
] as const)("renders reset %s without column padding as %s", (delta, reset) => {
  const resetsAt = delta === null ? null : new Date(NOW + delta).toISOString();
  expect(plain(success("claude", [window({ resetsAt })]))[1]).toBe(
    ` Claude 󱛡 Weekly 󰓅  93%  ${reset}${resetsAt ? ` ${resetsAt.slice(0, 10)} ${resetsAt.slice(11, 19)} (UTC)` : ""}`,
  );
});

test.each([
  ["codex", "Weekly", " Codex"],
  ["claude", "Sonnet weekly", " Claude"],
  ["claude", "週間界🙂e\u0301", " Claude"],
] as const)(
  "shows the whole UTC timestamp only when the %s/%s row fits",
  (provider, label, name) => {
    const now = Date.parse("2026-09-30T13:20:00Z");
    const state = success(provider, [
      window({ label, resetsAt: "2026-09-30T22:59:59.123Z" }),
    ]);
    const compact = `${name} 󱛡 ${label} 󰓅  93%  9h 39m`;
    const full = `${compact} 2026-09-30 22:59:59 (UTC)`;
    const cutoff = visibleWidth(full);
    const theme = makeTheme();
    // Resize the same state across the terminal-column boundary, including ANSI and wide glyphs.
    for (const width of [cutoff - 1, cutoff, cutoff + 1, cutoff - 1, cutoff]) {
      const row = renderUsageWidget(state, width, theme, now)[1] ?? "";
      expect(stripVTControlCharacters(row)).toBe(
        width >= cutoff ? full : compact,
      );
      expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
  },
);

test("fits reset timestamps independently for each quota row", () => {
  const resetsAt = "2026-09-30T22:59:59Z";
  const now = Date.parse("2026-09-30T13:20:00Z");
  const short = " Claude 󱛡 Weekly 󰓅  93%  9h 39m 2026-09-30 22:59:59 (UTC)";
  const long = " Claude 󱛡 Sonnet weekly 󰓅  93%  9h 39m";
  const state = success("claude", [
    window({ resetsAt }),
    window({ label: "Sonnet weekly", resetsAt }),
  ]);
  expect(
    renderUsageWidget(state, visibleWidth(short), makeTheme(), now)
      .slice(1)
      .map(stripVTControlCharacters),
  ).toEqual([short, long]);
});

test("unknown resets never add an absolute timestamp even with ample space", () => {
  const state = success("codex", [window({ resetsAt: null })]);
  expect(
    stripVTControlCharacters(
      renderUsageWidget(state, 500, makeTheme(), NOW)[1] ?? "",
    ),
  ).toBe(" Codex 󱛡 Weekly 󰓅  93%  -d --h --m");
});

test("uses render time rather than fetch time, including the default clock", () => {
  const state = success("codex", [
    window({ resetsAt: new Date(NOW + 120_000).toISOString() }),
  ]);
  expect(plain(state)[1]).toContain(" 2m");
  expect(plain(state, NOW + 60_000)[1]).toContain(" 1m");
  vi.spyOn(Date, "now").mockReturnValue(NOW + 120_000);
  expect(
    stripVTControlCharacters(
      renderUsageWidget(state, 120, makeTheme())[1] ?? "",
    ),
  ).toContain(" now");
});

test.each([
  [0, "  0%", undefined],
  [9, "  9%", undefined],
  [1.15, "1.2%", undefined],
  [12.35, "12.4%", undefined],
  [49.99, " 50%", undefined],
  [50, " 50%", undefined],
  [50.01, " 50%", "warning"],
  [75, " 75%", "warning"],
  [75.01, " 75%", "error"],
  [100, "100%", "error"],
  [101.23, "101.2%", "error"],
  [Number.MAX_VALUE, "1.7976931348623157e+308%", "error"],
] as const)(
  "formats %s percent using unrounded color thresholds",
  (usedPercent, percent, color) => {
    const theme = makeTheme();
    const row =
      renderUsageWidget(
        success("codex", [window({ usedPercent })]),
        120,
        theme,
        NOW,
      )[1] ?? "";
    expect(stripVTControlCharacters(row)).toContain(`󰓅 ${percent} `);
    expect(
      theme.fg.mock.calls.filter(
        ([token]) => token === "warning" || token === "error",
      ),
    ).toEqual(color ? [[color, percent]] : []);
    if (color)
      expect(row).toContain(`${colors[color]}${percent}${RESET}${colors.dim} `);
  },
);

test("matches the local pix-bg divider and restores dim text after each colored span", () => {
  const theme = makeTheme();
  const [divider, row] = renderUsageWidget(success(), 80, theme, NOW);
  expect(divider).toBe(
    `${colors.borderMuted}── ${RESET}${colors.muted}󱘖${RESET} ${colors.dim}Usage${RESET} ${colors.borderMuted}${"─".repeat(69)}${RESET}`,
  );
  expect(row).toBe(
    `${colors.dim}${colors.accent}${RESET}${colors.dim} Codex ${colors.text}󱛡${RESET}${colors.dim} Weekly ${colors.text}󰓅${RESET}${colors.dim} ${colors.error} 93%${RESET}${colors.dim} ${colors.text}${RESET}${colors.dim} 3d  9h 47m 2026-09-28 09:47:00 (UTC)${RESET}`,
  );
});

const otherStates: {
  state: UsageWidgetState;
  text: string;
  color?: "warning" | "error";
}[] = [
  { state: { status: "no-model" }, text: "No model selected." },
  {
    state: { status: "unsupported" },
    text: "Usage is not supported for this model.",
  },
  ...(["claude", "codex"] as const).flatMap((provider) => {
    const name = provider === "claude" ? " Claude" : " Codex";
    return [
      {
        state: { provider, status: "loading" } as const,
        text: `${name} Loading usage…`,
      },
      {
        state: success(provider, []),
        text: `${name} No quota windows reported.`,
      },
      {
        state: {
          provider,
          status: "unavailable",
          message: "No Pi subscription login; use /login with OAuth.",
        } as const,
        text: `${name} No Pi subscription login; use /login with OAuth.`,
        color: "warning" as const,
      },
      {
        state: {
          provider,
          status: "error",
          message: "Usage request timed out.",
        } as const,
        text: `${name} Usage request timed out.`,
        color: "error" as const,
      },
    ];
  }),
];

test.each(otherStates)(
  "shows an explicit $state.status state: $text",
  ({ state, text, color }) => {
    const theme = makeTheme();
    const rows = renderUsageWidget(state, 120, theme, NOW);
    expect(rows).toHaveLength(2);
    expect(stripVTControlCharacters(rows[1] ?? "")).toBe(text);
    expect(rows.join("\n")).not.toMatch(/0%|󰓅|/);
    expect(
      theme.fg.mock.calls.filter(
        ([token]) => token === "warning" || token === "error",
      ),
    ).toEqual(color && "message" in state ? [[color, state.message]] : []);
  },
);

test.each([
  success("claude", [window({ label: "週間界🙂e\u0301".repeat(20) })]),
  {
    provider: "codex",
    status: "error",
    message: "認証🙂e\u0301".repeat(20),
  } as const,
  ...otherStates.map(({ state }) => state),
])(
  "fits narrow widths without breaking ANSI sequences or wide characters: %j",
  (state) => {
    const theme = makeTheme();
    for (const width of [-1, 0]) {
      expect(renderUsageWidget(state, width, theme, NOW)).toEqual([]);
    }
    for (let width = 1; width <= 120; width++) {
      const rows = renderUsageWidget(state, width, theme, NOW);
      expect(rows).toHaveLength(2);
      expect(visibleWidth(rows[0] ?? "")).toBe(width);
      for (const row of rows) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
        const text = stripVTControlCharacters(row);
        expect(text).not.toMatch(/\p{Control}/u);
        expect(text).not.toMatch(/\p{Surrogate}/u);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Check that truncation introduces only complete SGR sequences.
        expect(row.replace(/\x1b\[[0-9;]*m/g, "")).toBe(text);
      }
    }
  },
);

test("uses the live theme on every call without changing normalized state", () => {
  const state = success();
  const original = structuredClone(state);
  const theme = makeTheme();
  const first = renderUsageWidget(state, 120, theme, NOW);
  const changed = makeTheme("\x1b[35m");
  const second = renderUsageWidget(state, 120, changed, NOW);
  expect(second.map(stripVTControlCharacters)).toEqual(
    first.map(stripVTControlCharacters),
  );
  expect(second).not.toEqual(first);
  expect(second.join("\n")).not.toContain(colors.dim);
  expect(second[1]).toContain(`\x1b[35m${RESET}\x1b[35m Codex`);
  theme.fg.mockImplementation(changed.fg);
  theme.getFgAnsi.mockImplementation(changed.getFgAnsi);
  expect(renderUsageWidget(state, 120, theme, NOW)).toEqual(second);
  expect(state).toEqual(original);
});
