import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatUsageReport } from "./report.ts";
import { UsageRequests } from "./requests.ts";
import type { UsageProvider } from "./types.ts";
import { UsageWidgetController } from "./widget-controller.ts";

const CHOICES = ["all", "claude", "codex", "toggle"] as const;

export default function subscriptionUsage(pi: ExtensionAPI): void {
  let active: AbortController | undefined;
  let widget: UsageWidgetController | undefined;
  const requests = new UsageRequests();

  pi.registerCommand("usage", {
    description:
      "Fetch subscription quotas or toggle the widget: /usage [claude|codex|all|toggle]",
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
      if (selection === "toggle") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("The usage widget requires terminal UI.", "warning");
          return;
        }
        if (widget) {
          widget.dispose();
          widget = undefined;
        } else {
          widget = new UsageWidgetController(ctx, requests);
        }
        ctx.ui.notify(`Usage widget ${widget ? "shown" : "hidden"}.`, "info");
        return;
      }
      if (
        selection !== "all" &&
        selection !== "claude" &&
        selection !== "codex"
      ) {
        ctx.ui.notify("Usage: /usage [claude|codex|all|toggle]", "warning");
        return;
      }
      if (active) {
        ctx.ui.notify("A subscription usage check is already running.", "info");
        return;
      }
      const controller = new AbortController();
      active = controller;
      const providers: UsageProvider[] =
        selection === "all" ? ["claude", "codex"] : [selection];
      try {
        const results = await Promise.all(
          providers.map((provider) =>
            requests.get(ctx.modelRegistry, provider, controller.signal),
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

  pi.on("session_start", (_event, ctx) => {
    widget?.dispose();
    widget =
      ctx.mode === "tui" ? new UsageWidgetController(ctx, requests) : undefined;
  });

  pi.on("model_select", (_event, ctx) => {
    // An earlier async handler can switch models before this event reaches us.
    if (ctx.mode === "tui") widget?.selectProvider(ctx, ctx.model?.provider);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (ctx.mode === "tui") widget?.refreshCurrentProvider(ctx);
  });

  pi.on("session_shutdown", () => {
    active?.abort();
    active = undefined;
    widget?.dispose();
    widget = undefined;
    requests.cancelAll();
  });
}
