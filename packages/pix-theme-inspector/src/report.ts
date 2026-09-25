import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describeColor, inspectColor } from "./colors.ts";
import { TOKENS } from "./tokens.ts";

export function formatThemeReport(theme: Theme): string {
  const nameWidth = Math.max(
    ...TOKENS.map((token) => visibleWidth(token.name)),
  );
  // Notifications are wrapped in dim by Pi. Explicitly restore normal text for
  // values and dim after every line; fg()/bg() reset only their own channel.
  const ambient = theme.getFgAnsi("dim");
  const lines = [
    theme.fg(
      "text",
      `Theme: ${JSON.stringify(theme.name ?? "(unnamed)")} | ${theme.getColorMode()} | ${TOKENS.length} tokens`,
    ) + ambient,
  ];
  let previousGroup = "";
  for (const token of TOKENS) {
    const group = `${token.kind === "foreground" ? "Foreground" : "Background"} / ${token.group}`;
    if (group !== previousGroup) {
      lines.push("", theme.fg("text", group) + ambient);
      previousGroup = group;
    }
    const ansi =
      token.kind === "foreground"
        ? theme.getFgAnsi(token.name)
        : theme.getBgAnsi(token.name);
    const color = inspectColor(ansi, token.kind);
    const label = token.name + " ".repeat(nameWidth - visibleWidth(token.name));
    if (token.kind === "foreground") {
      lines.push(
        theme.fg(color.kind === "unknown" ? "text" : token.name, label) +
          theme.fg("text", `  ${describeColor(color)}`) +
          ambient,
      );
      continue;
    }
    const swatch =
      color.kind === "unknown"
        ? theme.fg("text", "????")
        : theme.bg(token.name, "    ");
    lines.push(
      theme.fg("text", `${label}  [`) +
        swatch +
        theme.fg("text", `]  ${describeColor(color)}`) +
        ambient,
    );
  }
  // Leave wrapping to the notification's native Text component so resizes reflow
  // this report without clipping names or measuring a stale stdout column count.
  return lines.join("\n");
}
