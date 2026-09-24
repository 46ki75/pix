import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { ANSI } from "./ansi.ts";
import { formatDirectory } from "./location.ts";
import { powerline, type PowerlineSegment } from "./powerline.ts";

const THINKING_ICONS = {
  off: "󰹐",
  minimal: "󱩎",
  low: "󱩐",
  medium: "󱩒",
  high: "󱩔",
  xhigh: "󱩖",
  max: "󰛨",
} as const satisfies Record<
  NonNullable<ExtensionContext["thinkingLevel"]>,
  string
>;

export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatContextBar(percent: number | null | undefined): string {
  if (percent == null || !Number.isFinite(percent)) return "";
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.floor(clamped / 25);
  const partial = clamped % 25 > 0 ? 1 : 0;
  const color =
    percent > 75
      ? ANSI.fg.red
      : percent > 50
        ? ANSI.fg.yellow
        : ANSI.fg.brightGreen;
  return `${color}${"█".repeat(filled)}${"▓".repeat(partial)}${"░".repeat(4 - filled - partial)}${ANSI.reset.fg}`;
}

export function collectUsage(entries: readonly SessionEntry[]) {
  // Match Pi's cumulative accounting, including abandoned branches and compaction.
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let cacheHitRate: number | undefined;
  for (const entry of entries) {
    const usage =
      entry.type === "message"
        ? entry.message.role === "assistant" ||
          entry.message.role === "toolResult"
          ? entry.message.usage
          : undefined
        : "usage" in entry
          ? entry.usage
          : undefined;
    if (!usage) continue;
    if (entry.type === "message" && entry.message.role === "assistant") {
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      cacheHitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
    }
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost.total;
  }
  return { ...totals, cacheHitRate };
}

function singleLine(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").trim();
}

export function createFooter(
  ctx: ExtensionContext,
  tui: Pick<TUI, "requestRender">,
  theme: Pick<Theme, "fg">,
  footerData: ReadonlyFooterDataProvider,
  directory = formatDirectory(ctx.cwd),
): Component & { dispose(): void } {
  const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
  return {
    dispose: unsubscribe,
    // Session metrics and theme colors stay live; the directory is resolved at startup.
    invalidate() {},
    render(width) {
      if (width <= 0) return [];
      const usage = collectUsage(ctx.sessionManager.getEntries());
      const cacheText = ` ${usage.cacheHitRate === undefined ? "?" : `${usage.cacheHitRate.toFixed(1)}%`}`;

      const context = ctx.getContextUsage();
      const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow;
      const windowText = contextWindow ? formatTokens(contextWindow) : "?";
      const percent = context?.percent;
      const contextText = percent == null ? "?" : `${percent.toFixed(1)}%`;

      const model = ctx.model;
      const thinking = ctx.thinkingLevel ?? "off";
      const modelText = model
        ? `󱘖 ${model.provider}  ${model.id} (${windowText})${model.reasoning ? ` ${THINKING_ICONS[thinking]} ${thinking}` : ""}`
        : `no-model (${windowText})`;
      const left = theme.fg("dim", singleLine(modelText));
      // Only the bar changes to warning colors; the icon and percentage stay bright green.
      const right = [
        theme.fg("dim", cacheText),
        `${ANSI.fg.brightGreen}󰓅 ${contextText}${ANSI.reset.fg}`,
        formatContextBar(percent),
      ]
        .filter(Boolean)
        .join(" ");
      const padding = " ".repeat(
        Math.max(2, width - visibleWidth(left) - visibleWidth(right)),
      );
      const gitBranch = footerData.getGitBranch();
      const branch = gitBranch ? ` ${gitBranch}` : undefined;
      const name = ctx.sessionManager.getSessionName();
      const segments: PowerlineSegment[] = [
        { text: directory, background: "blue", foreground: "black" },
      ];
      const details = [branch, name].filter(Boolean).join(" • ");
      if (details) {
        segments.push({
          text: details,
          background: "brightBlue",
          foreground: "black",
        });
      }
      const lines = [
        truncateToWidth(left + padding + right, width),
        truncateToWidth(powerline(segments), width),
      ];
      const statuses = [...footerData.getExtensionStatuses()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => singleLine(text));
      if (statuses.length)
        lines.push(truncateToWidth(statuses.join(" "), width));
      return lines;
    },
  };
}
