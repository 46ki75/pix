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
  }
}

export function formatUsedPercent(
  usedPercent: number,
  formatText: UsageTextFormatter,
): string {
  // Large finite numbers are already integers; don't overflow them by scaling.
  const percent = `${String(
    Number.isInteger(usedPercent)
      ? usedPercent
      : Math.round(usedPercent * 10) / 10,
  ).padStart(3)}%`;
  const color =
    usedPercent > 75 ? "error" : usedPercent > 50 ? "warning" : undefined;
  return color ? formatText(color, percent) : percent;
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
        visibleWidth(formatUsedPercent(window.usedPercent, plainText)),
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
