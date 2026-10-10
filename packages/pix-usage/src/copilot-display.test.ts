import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { formatWindowUsage } from "./format.ts";
import { formatUsageReport } from "./report.ts";
import { parseCopilotUsage } from "./providers.ts";
import type { UsageResult, UsageWindow } from "./types.ts";
import { renderUsageWidget } from "./widget.ts";

const NOW = Date.parse("2026-10-10T00:00:00Z");
const plain = (_color: string, text: string) => text;
function window(
  overrides: { [K in keyof UsageWindow]?: UsageWindow[K] | undefined } = {},
): UsageWindow {
  const value: UsageWindow = {
    id: "premium_interactions",
    label: "AI credits",
    usedPercent: 28,
    amount: { used: 420, total: 1500, unit: "credits", estimated: false },
    resetsAt: "2026-11-01T00:00:00.000Z",
    windowSeconds: null,
  };
  Object.assign(value, overrides);
  if (value.amount === undefined) delete value.amount;
  if (value.quotaState === undefined) delete value.quotaState;
  return value;
}
function result(value = window()): UsageResult {
  return {
    provider: "copilot",
    status: "ok",
    usage: {
      provider: "copilot",
      fetchedAt: new Date(NOW).toISOString(),
      windows: [value],
    },
  };
}
function theme() {
  return {
    fg: vi.fn<Theme["fg"]>((_color, value) => `\x1b[36m${value}\x1b[39m`),
    getFgAnsi: () => "\x1b[2m",
  };
}

test("renders exact credits, grouping, and the reported percentage", () => {
  expect(formatWindowUsage(window(), plain)).toBe("420 / 1,500 credits (28%)");
  expect(formatUsageReport([result()], plain, NOW)).toContain(
    "AI credits 󰓅 420 / 1,500 credits (28%)         22d 2026-11-01 00:00:00 (UTC)",
  );
});

test.each([
  [{ quota_reset_date: "2026-11-01" }, "2026-11-01 (time unknown)"],
  [
    { quota_reset_date_utc: "2026-11-01T00:00:00Z" },
    "22d 2026-11-01 00:00:00 (UTC)",
  ],
] as const)(
  "renders a parsed account reset despite a zero category reset: %j",
  (reset, expected) => {
    const value = parseCopilotUsage({
      token_based_billing: true,
      ...reset,
      quota_snapshots: {
        premium_interactions: {
          unlimited: false,
          entitlement: "1500",
          quota_remaining: 1498.7,
          percent_remaining: 99.9,
          quota_reset_at: 0,
        },
      },
    })[0]!;
    const state = result(value);
    for (const output of [
      formatUsageReport([state], plain, NOW),
      stripVTControlCharacters(renderUsageWidget(state, 160, theme(), NOW)[1]!),
    ]) {
      expect(output).toContain("1.3 / 1,500 credits (0.1%)");
      expect(output).toContain(expected);
      expect(output).not.toContain("-d --h --m");
    }
  },
);

test("date-only resets stay visible without timezone conversion, countdowns, or a fabricated midnight", () => {
  const state = result(window({ resetsAt: null, resetsOn: "2026-11-01" }));
  for (const now of [
    NOW,
    Date.parse("2026-11-01T23:59:59Z"),
    Date.parse("2026-11-02T00:00:01Z"),
  ]) {
    const row = stripVTControlCharacters(
      renderUsageWidget(state, 160, theme(), now)[1]!,
    );
    expect(row).toBe(
      "  Copilot AI credits 󰓅 420 / 1,500 credits (28%)  2026-11-01 (time unknown)",
    );
    const report = formatUsageReport([state], plain, now);
    expect(report).toContain(" 2026-11-01 (time unknown)");
    expect(report).not.toMatch(/\b(?:UTC|ago|now)\b|00:00:00|22d|-d --h --m/);
    const width = visibleWidth(row);
    for (const size of [width - 1, width, width + 1, 80]) {
      const resized = stripVTControlCharacters(
        renderUsageWidget(state, size, theme(), now)[1]!,
      );
      expect(visibleWidth(resized)).toBeLessThanOrEqual(size);
      expect(resized).toContain("2026-11-01");
      if (size >= width) expect(resized).toBe(row);
    }
  }
});

test("date-only and precise resets keep mixed report columns aligned", () => {
  const dated = result(window({ resetsAt: null, resetsOn: "2026-11-01" }));
  const precise = result();
  const report = formatUsageReport([dated, precise], plain, NOW);
  const rows = report.split("\n").filter((line) => line.includes(""));
  expect(
    new Set(rows.map((line) => visibleWidth(line.slice(0, line.indexOf("")))))
      .size,
  ).toBe(1);
  expect(rows[0]).toContain("2026-11-01 (time unknown)");
  expect(rows[1]).toContain("22d 2026-11-01 00:00:00 (UTC)");
});

test("renders estimates and fractional premium request amounts", () => {
  expect(
    formatWindowUsage(
      window({
        amount: {
          used: 420.25,
          total: 1500,
          unit: "requests",
          estimated: true,
        },
      }),
      plain,
    ),
  ).toBe("≈420.25 / 1,500 requests (28%)");
});

test("small positive amounts never round down to fabricated zero", () => {
  expect(
    formatWindowUsage(
      window({
        amount: { used: 0.001, total: 1500, unit: "credits", estimated: false },
      }),
      plain,
    ),
  ).toContain("<0.01 / 1,500 credits");
});

test.each([0, 420.25])(
  "renders uncapped credits %s without fake percentages",
  (used) => {
    const value = window({
      usedPercent: null,
      quotaState: "unlimited",
      amount: { used, total: null, unit: "credits", estimated: false },
    });
    expect(formatWindowUsage(value, plain)).toBe(
      `${used} credits used · limit unavailable`,
    );
    expect(formatUsageReport([result(value)], plain, NOW)).not.toContain("%");
  },
);

test.each([
  ["unlimited", "No individual limit reported"],
  ["unavailable", "Quota unavailable"],
  [undefined, "Usage unavailable"],
] as const)("renders %s without fake amounts", (quotaState, text) => {
  expect(
    formatWindowUsage(
      window({ usedPercent: null, amount: undefined, quotaState }),
      plain,
    ),
  ).toBe(text);
});

test("keeps historical usage distinct from an unavailable pooled allowance", () => {
  expect(
    formatWindowUsage(
      window({
        usedPercent: null,
        quotaState: "unavailable",
        amount: { used: 420, total: null, unit: "credits", estimated: false },
      }),
      plain,
    ),
  ).toBe("420 credits used · quota unavailable");
});

test("preserves percent-only provider formatting and its thresholds", () => {
  const color = vi.fn((_color: string, text: string) => text);
  expect(
    formatWindowUsage(window({ amount: undefined, usedPercent: 75.01 }), color),
  ).toBe(" 75%");
  expect(color).toHaveBeenCalledWith("error", " 75%");
  color.mockClear();
  expect(formatWindowUsage(window({ usedPercent: 75.01 }), color)).toBe(
    "420 / 1,500 credits (75%)",
  );
  expect(color).toHaveBeenCalledWith("error", "75%");
});

test("mixed reports align reset columns despite different amount widths", () => {
  const copilot = result();
  const claude: UsageResult = {
    provider: "claude",
    status: "ok",
    usage: {
      provider: "claude",
      fetchedAt: new Date(NOW).toISOString(),
      windows: [
        window({
          id: "five_hour",
          label: "5-hour",
          amount: undefined,
          windowSeconds: 18000,
        }),
      ],
    },
  };
  const lines = formatUsageReport([copilot, claude], plain, NOW)
    .split("\n")
    .filter((line) => line.includes(""));
  expect(
    new Set(lines.map((line) => visibleWidth(line.slice(0, line.indexOf("")))))
      .size,
  ).toBe(1);
});

test("widget uses the same values and drops the complete UTC timestamp on resize", () => {
  const state = result();
  const t = theme();
  const full = stripVTControlCharacters(
    renderUsageWidget(state, 160, t, NOW)[1]!,
  );
  expect(full).toContain("Copilot AI credits 󰓅 420 / 1,500 credits (28%)");
  expect(full).toContain("2026-11-01 00:00:00 (UTC)");
  const cutoff = visibleWidth(full);
  for (const width of [cutoff, cutoff - 1, cutoff + 1]) {
    const line = stripVTControlCharacters(
      renderUsageWidget(state, width, t, NOW)[1]!,
    );
    expect(line.includes("2026-11-01")).toBe(width >= cutoff);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(line).toContain("420 / 1,500");
  }
});

test.each([0, 1, 12, 24, 60, 80, 120])(
  "bounds every metric shape at width %s",
  (width) => {
    for (const value of [
      window(),
      window({ usedPercent: null, amount: undefined, quotaState: "unlimited" }),
      window({
        usedPercent: null,
        amount: {
          used: 999999,
          total: null,
          unit: "credits",
          estimated: false,
        },
        quotaState: "unavailable",
      }),
    ]) {
      const lines = renderUsageWidget(result(value), width, theme(), NOW);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  },
);
