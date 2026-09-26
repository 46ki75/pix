import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveUsage } from "./auth.ts";
import { formatUsageReport } from "./report.ts";
import type { UsageProvider } from "./types.ts";

const COMMAND_TIMEOUT_MS = 20_000;
const CHOICES = ["all", "claude", "codex"] as const;

export default function subscriptionUsage(pi: ExtensionAPI): void {
  let active: AbortController | undefined;

  pi.registerCommand("usage", {
    description:
      "Fetch Claude/Codex subscription quotas: /usage [claude|codex|all]",
    getArgumentCompletions(prefix) {
      const items = CHOICES.filter((value) => value.startsWith(prefix)).map(
        (value) => ({ value, label: value }),
      );
      return items.length ? items : null;
    },
    async handler(args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify("/usage requires interactive or RPC UI.", "warning");
        return;
      }
      const selection = args.trim() || "all";
      if (
        selection !== "all" &&
        selection !== "claude" &&
        selection !== "codex"
      ) {
        ctx.ui.notify("Usage: /usage [claude|codex|all]", "warning");
        return;
      }
      if (active) {
        ctx.ui.notify("A subscription usage check is already running.", "info");
        return;
      }
      const controller = new AbortController();
      active = controller;
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(COMMAND_TIMEOUT_MS),
      ]);
      const providers: UsageProvider[] =
        selection === "all" ? ["claude", "codex"] : [selection];
      try {
        const results = await Promise.all(
          providers.map((provider) =>
            resolveUsage(ctx.modelRegistry, provider, signal),
          ),
        );
        // Shutdown/reload invalidates ctx. Never deliver old results to a new session.
        if (controller.signal.aborted || active !== controller) return;
        const theme = ctx.mode === "tui" ? ctx.ui.theme : undefined;
        // Keep the frame neutral: warning notifications prepend "Warning: " and
        // tint the whole report. Provider failures are styled inside their sections.
        ctx.ui.notify(
          formatUsageReport(
            results,
            theme
              ? (color, text) => {
                  // fg() resets to the terminal default; restore Pi's info color
                  // after each span so a provider's severity cannot leak into others.
                  return theme.fg(color, text) + theme.getFgAnsi("dim");
                }
              : undefined,
          ),
          "info",
        );
      } finally {
        if (active === controller) active = undefined;
      }
    },
  });

  pi.on("session_shutdown", () => {
    active?.abort();
    active = undefined;
  });
}
