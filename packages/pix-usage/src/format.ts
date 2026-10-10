import { visibleWidth } from "@earendil-works/pi-tui";
import type { UsageProvider, UsageWindow } from "./types.ts";

export type UsageTextFormatter = (
  color: "accent" | "text" | "warning" | "error",
  text: string,
) => string;

export function formatProviderName(
  provider: UsageProvider,
  formatText: UsageTextFormatter,
): string {
  switch (provider) {
    case "claude":
      return `${formatText("accent", "")} Claude`;
    case "codex":
      return `${formatText("accent", "")} Codex`;
    case "muse":
      return `${formatText("accent", "󰛤")} Muse`;
    case "opencode":
      return `${formatText("accent", "󰨔")} OpenCode Go`;
    case "copilot":
      return `${formatText("accent", "")} Copilot`;
  }
}

export function formatUsedPercent(
  usedPercent: number,
  formatText: UsageTextFormatter,
  minimumWidth = 3,
): string {
  // Large finite numbers are already integers; don't overflow them by scaling.
  const percent = `${String(
    Number.isInteger(usedPercent)
      ? usedPercent
      : Math.round(usedPercent * 10) / 10,
  ).padStart(minimumWidth)}%`;
  const color =
    usedPercent > 75 ? "error" : usedPercent > 50 ? "warning" : undefined;
  return color ? formatText(color, percent) : percent;
}

const amountFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

function formatAmount(value: number): string {
  return value > 0 && value < 0.01 ? "<0.01" : amountFormat.format(value);
}

export function formatWindowUsage(
  window: UsageWindow,
  formatText: UsageTextFormatter,
): string {
  const { amount, usedPercent } = window;
  if (amount) {
    const used = `${amount.estimated ? "≈" : ""}${formatAmount(amount.used)}`;
    if (amount.total !== null) {
      const percent =
        usedPercent === null
          ? ""
          : ` (${formatUsedPercent(usedPercent, formatText, 0)})`;
      return `${used} / ${formatAmount(amount.total)} ${amount.unit}${percent}`;
    }
    const limit =
      window.quotaState === "unavailable"
        ? formatText("warning", "quota unavailable")
        : "limit unavailable";
    return `${used} ${amount.unit} used · ${limit}`;
  }
  if (usedPercent !== null) return formatUsedPercent(usedPercent, formatText);
  if (window.quotaState === "unavailable")
    return formatText("warning", "Quota unavailable");
  return window.quotaState === "unlimited"
    ? "No individual limit reported"
    : "Usage unavailable";
}

export function formatWindowIcon(
  window: Pick<UsageWindow, "id" | "windowSeconds">,
  formatText: UsageTextFormatter,
): string {
  // Fixed windows use their duration, not position. OpenCode's monthly reset
  // follows the subscription date, so its semantic ID supplies the icon.
  return window.id === "monthly"
    ? `${formatText("text", "󰸗")} `
    : window.windowSeconds === 5 * 3600
      ? `${formatText("text", "")} `
      : window.windowSeconds === 7 * 86400
        ? `${formatText("text", "󱛡")} `
        : "";
}

export interface UsageWindowColumnWidths {
  label: number;
  usage: number;
  reset: number;
}

const plainText: UsageTextFormatter = (_color, text) => text;

export function usageWindowColumnWidths(
  windows: readonly UsageWindow[],
  now: number,
  options: {
    minimumResetWidth?: number;
    trimResetStart?: boolean;
  } = {},
): UsageWindowColumnWidths {
  return {
    label: Math.max(
      0,
      ...windows.map((window) =>
        visibleWidth(`${formatWindowIcon(window, plainText)}${window.label}`),
      ),
    ),
    usage: Math.max(
      0,
      ...windows.map((window) =>
        visibleWidth(formatWindowUsage(window, plainText)),
      ),
    ),
    reset: Math.max(
      options.minimumResetWidth ?? 10,
      ...windows.map((window) => {
        const reset = window.resetsAt
          ? relativeResetTime(window.resetsAt, now)
          : "-d --h --m";
        return visibleWidth(options.trimResetStart ? reset.trimStart() : reset);
      }),
    ),
  };
}

export function padVisibleEnd(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

export function padVisibleStart(value: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(value))) + value;
}

export function absoluteResetTime(resetsAt: string): string {
  return new Date(resetsAt)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " (UTC)");
}

export function relativeResetTime(resetsAt: string, now: number): string {
  const delta = Date.parse(resetsAt) - now;
  if (delta === 0) return "now";
  const minutes = Math.floor(Math.abs(delta) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  const duration =
    [
      days ? `${days}d` : "",
      hours ? `${String(hours).padStart(2)}h` : "",
      remainingMinutes ? `${String(remainingMinutes).padStart(2)}m` : "",
    ]
      .filter(Boolean)
      .join(" ") || "<1m";
  return delta > 0 ? duration : `${duration} ago`;
}
