import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { formatUsageReport } from "./report.ts";

const NOW = Date.parse("2026-09-25T00:00:00.000Z");
function reportBody(...args: Parameters<typeof formatUsageReport>): string {
  return formatUsageReport(...args)
    .split("\n")
    .slice(2, -2)
    .join("\n");
}

test("frames an empty report with enough room for the title", () => {
  expect(formatUsageReport([])).toBe("── 󱘖 Usage ─\n\n────────────");
});

test.each(
  (
    [
      ["", 12],
      ["No login.", 12],
      ["認証".repeat(4), 18],
      ["x".repeat(90), 92],
    ] as const
  ).flatMap(([message, width]) =>
    [false, true].map((themed) => ({ message, width, themed })),
  ),
)(
  "sizes dividers to visible content ($width columns, themed: $themed)",
  ({ message, width, themed }) => {
    const report = formatUsageReport(
      [{ provider: "claude", status: "error", message }],
      themed ? (_color, text) => `\u001b[36m${text}\u001b[39m` : undefined,
      NOW,
    );
    const lines = report.split("\n");
    expect(visibleWidth(lines[0] ?? "")).toBe(width);
    expect(visibleWidth(lines.at(-1) ?? "")).toBe(width);
    expect(stripVTControlCharacters(report)).toBe(
      `── 󱘖 Usage ${"─".repeat(width - 11)}\n\n Claude\n\n  ${message}\n\n${"─".repeat(width)}`,
    );
  },
);

test.each(["claude", "codex"] as const)(
  "sizes the shared frame to the longest provider section (%s)",
  (longest) => {
    const report = formatUsageReport(
      (["claude", "codex"] as const).map((provider) => ({
        provider,
        status: "error" as const,
        message: provider === longest ? "x".repeat(30) : "Short.",
      })),
    );
    const width = 32;
    const lines = report.split("\n");
    expect(lines[0]).toBe(`── 󱘖 Usage ${"─".repeat(width - 11)}`);
    expect(lines.at(-1)).toBe("─".repeat(width));
    expect(report.match(/󱘖 Usage/g)).toHaveLength(1);
  },
);

test("formats normalized usage and unknown resets without guessing remaining quota", () => {
  expect(
    formatUsageReport(
      [
        {
          provider: "claude",
          status: "ok",
          usage: {
            provider: "claude",
            fetchedAt: "2026-09-25T06:28:18.527Z",
            windows: [
              {
                id: "five_hour",
                label: "5-hour",
                usedPercent: 0,
                resetsAt: null,
                windowSeconds: 18000,
              },
              {
                id: "seven_day",
                label: "Weekly",
                usedPercent: 101.23,
                resetsAt: "2026-09-30T23:00:00.363Z",
                windowSeconds: 604800,
              },
            ],
          },
        },
      ],
      undefined,
      Date.parse("2026-09-25T06:28:18.527Z"),
    ),
  ).toBe(
    `── 󱘖 Usage ${"─".repeat(47)}\n\n Claude\n\n   5-hour 󰓅   0%  -d --h --m\n  󱛡 Weekly 󰓅 101.2%  5d 16h 31m 2026-09-30 23:00:00 (UTC)\n\n${"─".repeat(58)}`,
  );
});

test.each([false, true])(
  "aligns short countdowns with weekly resets across providers (themed: %s)",
  (themed) => {
    const now = Date.parse("2026-09-25T12:00:00.000Z");
    const report = formatUsageReport(
      [
        {
          provider: "claude",
          status: "ok",
          usage: {
            provider: "claude",
            fetchedAt: new Date(now).toISOString(),
            windows: [
              {
                id: "five_hour",
                label: "5-hour",
                usedPercent: 0,
                resetsAt: "2026-09-25T16:59:59.000Z",
                windowSeconds: 18000,
              },
              {
                id: "seven_day",
                label: "Weekly",
                usedPercent: 0,
                resetsAt: "2026-09-30T22:59:59.000Z",
                windowSeconds: 604800,
              },
            ],
          },
        },
        {
          provider: "codex",
          status: "ok",
          usage: {
            provider: "codex",
            fetchedAt: new Date(now).toISOString(),
            windows: [
              {
                id: "primary_window",
                label: "Weekly",
                usedPercent: 86,
                resetsAt: "2026-09-29T21:50:45.000Z",
                windowSeconds: 604800,
              },
            ],
          },
        },
      ],
      themed ? (_color, text) => `\u001b[36m${text}\u001b[39m` : undefined,
      now,
    );
    const rows = stripVTControlCharacters(report)
      .split("\n")
      .filter((line) => line.includes(""));
    expect(rows).toEqual([
      "   5-hour 󰓅   0%      4h 59m 2026-09-25 16:59:59 (UTC)",
      "  󱛡 Weekly 󰓅   0%  5d 10h 59m 2026-09-30 22:59:59 (UTC)",
      "  󱛡 Weekly 󰓅  86%  4d  9h 50m 2026-09-29 21:50:45 (UTC)",
    ]);
    const dateColumns = rows.map((row) =>
      visibleWidth(row.slice(0, row.indexOf("2026-"))),
    );
    expect(new Set(dateColumns).size).toBe(1);
  },
);

test.each([
  [0, "  0"],
  [9, "  9"],
  [10, " 10"],
  [99, " 99"],
  [100, "100"],
  [1.15, "1.2"],
  [12.35, "12.4"],
  [12.34, "12.3"],
  [101.23, "101.2"],
] as const)(
  "pads %s percent without truncating decimals",
  (usedPercent, percent) => {
    expect(
      reportBody([
        {
          provider: "claude",
          status: "ok",
          usage: {
            provider: "claude",
            fetchedAt: new Date(NOW).toISOString(),
            windows: [
              {
                id: "five_hour",
                label: "5-hour",
                usedPercent,
                resetsAt: null,
                windowSeconds: 18000,
              },
            ],
          },
        },
      ]),
    ).toBe(` Claude\n\n   5-hour 󰓅 ${percent}%  -d --h --m`);
  },
);

test.each([
  [0, "  0%", undefined],
  [49.99, " 50%", undefined],
  [50, " 50%", undefined],
  [50.01, " 50%", "warning"],
  [75, " 75%", "warning"],
  [75.01, " 75%", "error"],
  [100, "100%", "error"],
  [101.23, "101.2%", "error"],
  [1e308, "1e+308%", "error"],
  [Number.MAX_VALUE, "1.7976931348623157e+308%", "error"],
] as const)(
  "colors unrounded usage of %s percent",
  (usedPercent, percent, color) => {
    const formatText = vi.fn(
      (token: string, text: string) => `<${token}>${text}</${token}>`,
    );
    const results = (["claude", "codex"] as const).map((provider) => ({
      provider,
      status: "ok" as const,
      usage: {
        provider,
        fetchedAt: new Date(NOW).toISOString(),
        windows: [
          {
            id: "weekly",
            label: "Weekly",
            usedPercent,
            resetsAt: null,
            windowSeconds: 604800,
          },
        ],
      },
    }));
    const report = formatUsageReport(results, formatText, NOW);
    const expected = color ? `<${color}>${percent}</${color}>` : percent;
    expect(report).toContain(`<text>󰓅</text> ${expected} <text></text>`);
    expect(
      formatText.mock.calls.filter(
        ([token]) => token === "warning" || token === "error",
      ),
    ).toEqual(
      color
        ? [
            [color, percent],
            [color, percent],
          ]
        : [],
    );
  },
);

test.each([
  [1, "       <1m"],
  [59_999, "       <1m"],
  [60_000, "        1m"],
  [3_599_999, "       59m"],
  [3_600_000, "        1h"],
  [135 * 60_000, "    2h 15m"],
  [86_400_000, "        1d"],
  [(4 * 1440 + 14 * 60 + 8) * 60_000, "4d 14h  8m"],
  [(4 * 1440 + 4 * 60 + 8) * 60_000, "4d  4h  8m"],
  [(4 * 1440 + 17 * 60 + 42) * 60_000, "4d 17h 42m"],
  [7 * 86_400_000, "        7d"],
  [(12 * 1440 + 14 * 60 + 8) * 60_000, "12d 14h  8m"],
  [0, "       now"],
  [-1, "   <1m ago"],
  [-60_000, "    1m ago"],
  [-3_600_000, "    1h ago"],
  [-(4 * 1440 + 14 * 60 + 8) * 60_000, "4d 14h  8m ago"],
] as const)(
  "formats a reset %s ms from display time as %s",
  (delta, relative) => {
    const resetsAt = new Date(NOW + delta).toISOString();
    const fetchedAt = new Date(NOW - 20_000).toISOString();
    const results = (["claude", "codex"] as const).map((provider) => ({
      provider,
      status: "ok" as const,
      usage: {
        provider,
        fetchedAt,
        windows: [
          {
            id: "weekly",
            label: "Weekly",
            usedPercent: 10,
            resetsAt,
            windowSeconds: 604800,
          },
        ],
      },
    }));
    expect(reportBody(results, undefined, NOW)).toBe(
      [" Claude", " Codex"]
        .map(
          (name) =>
            `${name}\n\n  󱛡 Weekly 󰓅  10%  ${relative} ${resetsAt.slice(0, 10)} ${resetsAt.slice(11, 19)} (UTC)`,
        )
        .join("\n\n"),
    );
  },
);

test("empty quotas and unavailable providers are not displayed as zero usage", () => {
  expect(
    reportBody([
      {
        provider: "claude",
        status: "ok",
        usage: {
          provider: "claude",
          fetchedAt: "2026-09-25T00:00:00.000Z",
          windows: [],
        },
      },
      {
        provider: "codex",
        status: "unavailable",
        message: "No subscription login.",
      },
    ]),
  ).toBe(
    " Claude\n\n  No quota windows reported.\n\n Codex\n\n  No subscription login.",
  );
});

test.each([
  ["unavailable", "warning"],
  ["error", "error"],
] as const)(
  "keeps %s details below the heading and colors only the message",
  (status, color) => {
    const formatText = vi.fn(
      (token: string, text: string) => `<${token}>${text}</${token}>`,
    );
    const body = reportBody(
      [
        { provider: "claude", status, message: "Sign in again." },
        {
          provider: "codex",
          status: "ok",
          usage: {
            provider: "codex",
            fetchedAt: new Date(NOW).toISOString(),
            windows: [
              {
                id: "weekly",
                label: "Weekly",
                usedPercent: 90,
                resetsAt: null,
                windowSeconds: 604800,
              },
            ],
          },
        },
      ],
      formatText,
      NOW,
    );
    expect(body).toBe(
      `<accent></accent> Claude\n\n  <${color}>Sign in again.</${color}>\n\n<accent></accent> Codex\n\n  <text>󱛡</text> Weekly <text>󰓅</text> <error> 90%</error> <text></text> -d --h --m`,
    );
    expect(
      formatText.mock.calls.filter(
        ([token]) => token === "warning" || token === "error",
      ),
    ).toEqual([
      [color, "Sign in again."],
      ["error", " 90%"],
    ]);
  },
);

test("safe errors are labeled by provider", () => {
  expect(
    reportBody([
      {
        provider: "codex",
        status: "error",
        message: "Usage request timed out.",
      },
    ]),
  ).toBe(" Codex\n\n  Usage request timed out.");
});

test.each([
  [18000, "5-hour", " "],
  [604800, "Weekly", "󱛡 "],
  [604800, "Sonnet weekly", "󱛡 "],
  [604800, "Opus weekly", "󱛡 "],
  [900, "15-minute", ""],
  [null, "Primary", ""],
] as const)(
  "uses the reported duration for the %s-second window icon",
  (windowSeconds, label, icon) => {
    expect(
      reportBody([
        {
          provider: "codex",
          status: "ok",
          usage: {
            provider: "codex",
            fetchedAt: "2026-09-25T00:00:00.000Z",
            windows: [
              {
                id: "primary_window",
                label,
                usedPercent: 10,
                resetsAt: null,
                windowSeconds,
              },
            ],
          },
        },
      ]),
    ).toBe(` Codex\n\n  ${icon}${label} 󰓅  10%  -d --h --m`);
  },
);
