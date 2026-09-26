import type { UsageProvider } from "./types.ts";

export type UsageTextFormatter = (
  color: "accent" | "text" | "warning" | "error",
  text: string,
) => string;

export function formatProviderName(
  provider: UsageProvider,
  formatText: UsageTextFormatter,
): string {
  return provider === "claude"
    ? `${formatText("accent", "")} Claude`
    : `${formatText("accent", "")} Codex`;
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
  windowSeconds: number | null,
  formatText: UsageTextFormatter,
): string {
  // Codex may report a weekly primary window; use duration, not position.
  return windowSeconds === 5 * 3600
    ? `${formatText("text", "")} `
    : windowSeconds === 7 * 86400
      ? `${formatText("text", "󱛡")} `
      : "";
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
