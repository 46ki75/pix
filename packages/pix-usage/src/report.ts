import { visibleWidth } from "@earendil-works/pi-tui";
import {
  absoluteResetTime,
  formatProviderName,
  formatUsedPercent,
  formatWindowIcon,
  relativeResetTime,
} from "./format.ts";
import type { UsageResult } from "./types.ts";

export function formatUsageReport(
  results: readonly UsageResult[],
  formatText: (
    color: "border" | "accent" | "text" | "warning" | "error",
    text: string,
  ) => string = (_color, text) => text,
  now = Date.now(),
): string {
  const body = results
    .map((result) => {
      const name = formatProviderName(result.provider, formatText);
      if (result.status !== "ok") {
        const color = result.status === "unavailable" ? "warning" : "error";
        return `${name}\n\n  ${formatText(color, result.message)}`;
      }
      if (result.usage.windows.length === 0)
        return `${name}\n\n  No quota windows reported.`;
      const rows = result.usage.windows.map((window) => {
        const usage = formatUsedPercent(window.usedPercent, formatText);
        // Reserve the width of "0d 00h 00m" even when countdown units are omitted.
        const reset = window.resetsAt
          ? `${relativeResetTime(window.resetsAt, now).padStart(10)} ${absoluteResetTime(window.resetsAt)}`
          : "-d --h --m";
        const icon = formatWindowIcon(window.windowSeconds, formatText);
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
