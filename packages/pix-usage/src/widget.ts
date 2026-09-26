import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  absoluteResetTime,
  formatProviderName,
  formatUsedPercent,
  formatWindowIcon,
  relativeResetTime,
  type UsageTextFormatter,
} from "./format.ts";
import type { UsageProvider, UsageResult } from "./types.ts";

export type UsageWidgetState =
  | UsageResult
  | { status: "loading"; provider: UsageProvider }
  | { status: "unsupported" }
  | { status: "no-model" };

function renderRows(
  state: UsageWidgetState,
  formatText: UsageTextFormatter,
  now: number,
  width: number,
): string[] {
  if (state.status === "no-model") return ["No model selected."];
  if (state.status === "unsupported")
    return ["Usage is not supported for this model."];
  const name = formatProviderName(state.provider, formatText);
  if (state.status === "loading") return [`${name} Loading usage…`];
  if (state.status !== "ok") {
    const color = state.status === "unavailable" ? "warning" : "error";
    return [`${name} ${formatText(color, state.message)}`];
  }
  if (!state.usage.windows.length)
    return [`${name} No quota windows reported.`];
  return state.usage.windows.map((window) => {
    const icon = formatWindowIcon(window.windowSeconds, formatText);
    const usage = formatUsedPercent(window.usedPercent, formatText);
    const reset = window.resetsAt
      ? relativeResetTime(window.resetsAt, now).trimStart()
      : "-d --h --m";
    const row = `${name} ${icon}${window.label} ${formatText("text", "󰓅")} ${usage} ${formatText("text", "")} ${reset}`;
    if (!window.resetsAt) return row;
    const full = `${row} ${absoluteResetTime(window.resetsAt)}`;
    // Drop the optional timestamp as a unit instead of showing a partial date.
    return visibleWidth(full) <= width ? full : row;
  });
}

export function renderUsageWidget(
  state: UsageWidgetState,
  width: number,
  theme: Pick<Theme, "fg" | "getFgAnsi">,
  now = Date.now(),
): string[] {
  if (width < 1) return [];
  const heading =
    theme.fg("borderMuted", "── ") +
    `${theme.fg("muted", "󱘖")} ${theme.fg("dim", "Usage")} `;
  const rule = theme.fg(
    "borderMuted",
    "─".repeat(Math.max(0, width - visibleWidth(heading))),
  );
  const dim = theme.getFgAnsi("dim");
  // Pi's fg() resets to the terminal foreground, not the enclosing dim color.
  const formatText: UsageTextFormatter = (color, text) =>
    theme.fg(color, text) + dim;
  return [
    truncateToWidth(heading + rule, width),
    ...renderRows(state, formatText, now, width - 1).map(
      (row) => ` ${truncateToWidth(theme.fg("dim", row), width - 1)}`,
    ),
  ];
}
