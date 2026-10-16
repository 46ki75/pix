import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { StoredCredentialReader } from "./auth.ts";
import { getUsageCapability } from "./capabilities.ts";
import { formatUsageReport } from "./report.ts";
import { UsageRequests } from "./requests.ts";
import type { UsageProvider } from "./types.ts";
import { UsageWidgetController } from "./widget-controller.ts";

const CHOICES = [
  "all",
  "claude",
  "openai",
  "codex",
  "muse",
  "opencode",
  "copilot",
  "toggle",
] as const;

interface SubscriptionUsageOptions {
  readCredential?: StoredCredentialReader;
}

function notifyUsageWarning(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const capability = getUsageCapability(ctx.model?.provider);
  if (
    capability.status === "unsupported" ||
    capability.status === "unimplemented"
  )
    ctx.ui.notify(capability.message, "warning");
}

export default function subscriptionUsage(
  pi: ExtensionAPI,
  options: SubscriptionUsageOptions = {},
): void {
  let active: AbortController | undefined;
  let widget: UsageWidgetController | undefined;
  let sessionStarted = false;
  let selectedProviderId: string | undefined;
  const requests = new UsageRequests(options.readCredential);

  pi.registerCommand("usage", {
    description:
      "Show subscription usage or toggle the widget: /usage [claude|openai|codex|muse|opencode|copilot|all|toggle]",
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
        const message = !widget
          ? "Usage widget hidden."
          : getUsageCapability(ctx.model?.provider).status === "supported"
            ? "Usage widget shown."
            : "Usage widget enabled; it will appear for providers with usage fetching.";
        ctx.ui.notify(message, "info");
        return;
      }
      if (
        selection !== "all" &&
        selection !== "claude" &&
        selection !== "openai" &&
        selection !== "codex" &&
        selection !== "muse" &&
        selection !== "opencode" &&
        selection !== "copilot"
      ) {
        ctx.ui.notify(
          "Usage: /usage [claude|openai|codex|muse|opencode|copilot|all|toggle]",
          "warning",
        );
        return;
      }
      if (active) {
        ctx.ui.notify("A subscription usage check is already running.", "info");
        return;
      }
      const controller = new AbortController();
      active = controller;
      const providers: UsageProvider[] =
        selection === "all"
          ? ["claude", "openai", "codex", "muse", "opencode", "copilot"]
          : [selection];
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
    sessionStarted = true;
    selectedProviderId = ctx.model?.provider;
    widget =
      ctx.mode === "tui" ? new UsageWidgetController(ctx, requests) : undefined;
    notifyUsageWarning(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    // An earlier async handler can switch models before this event reaches us.
    const providerId = ctx.model?.provider;
    widget?.selectProvider(ctx, providerId);
    if (!sessionStarted || providerId === selectedProviderId) return;
    selectedProviderId = providerId;
    notifyUsageWarning(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (ctx.mode === "tui") widget?.refreshCurrentProvider(ctx);
  });

  pi.on("session_shutdown", () => {
    sessionStarted = false;
    selectedProviderId = undefined;
    active?.abort();
    active = undefined;
    widget?.dispose();
    widget = undefined;
    requests.cancelAll();
  });
}
