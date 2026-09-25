import { visibleWidth } from "@earendil-works/pi-tui";
import type { UsageResult } from "./types.ts";

function relativeResetTime(resetsAt: string, now: number): string {
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

function absoluteResetTime(resetsAt: string): string {
  return new Date(resetsAt)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " (UTC)");
}

export function formatUsageReport(
  results: readonly UsageResult[],
  formatText: (
    color: "border" | "muted" | "text" | "warning" | "error",
    text: string,
  ) => string = (_color, text) => text,
  now = Date.now(),
): string {
  const body = results
    .map((result) => {
      const name =
        result.provider === "claude"
          ? `${formatText("muted", "")} Claude`
          : `${formatText("muted", "")} Codex`;
      if (result.status !== "ok") return `${name}: ${result.message}`;
      if (result.usage.windows.length === 0)
        return `${name}: No quota windows reported.`;
      const rows = result.usage.windows.map((window) => {
        // Large finite numbers are already integers; don't overflow them by scaling.
        const percent = String(
          Number.isInteger(window.usedPercent)
            ? window.usedPercent
            : Math.round(window.usedPercent * 10) / 10,
        ).padStart(3);
        const percentColor =
          window.usedPercent > 75
            ? "error"
            : window.usedPercent > 50
              ? "warning"
              : undefined;
        const usage = percentColor
          ? formatText(percentColor, `${percent}%`)
          : `${percent}%`;
        // Reserve the width of "0d 00h 00m" even when countdown units are omitted.
        const reset = window.resetsAt
          ? `${relativeResetTime(window.resetsAt, now).padStart(10)} ${absoluteResetTime(window.resetsAt)}`
          : "-d --h --m";
        // Codex may report a weekly primary window; use duration, not position.
        const icon =
          window.windowSeconds === 5 * 3600
            ? `${formatText("text", "")} `
            : window.windowSeconds === 7 * 86400
              ? `${formatText("text", "󱛡")} `
              : "";
        return `  ${icon}${window.label} ${formatText("text", "󰓅")} ${usage} ${formatText("text", "")} ${reset}`;
      });
      return [name, "", ...rows].join("\n");
    })
    .join("\n\n");
  const title = "── 󱘖 Usage ";
  const dividerWidth = Math.max(
    visibleWidth(title) + 1,
    ...body.split("\n").map(visibleWidth),
  );
  return [
    formatText(
      "border",
      title + "─".repeat(dividerWidth - visibleWidth(title)),
    ),
    body,
    formatText("border", "─".repeat(dividerWidth)),
  ]
    .filter(Boolean)
    .join("\n\n");
}
