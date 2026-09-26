import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageRequests } from "./requests.ts";
import type { UsageProvider } from "./types.ts";
import { renderUsageWidget, type UsageWidgetState } from "./widget.ts";

const REFRESH_MS = 5 * 60_000;
const MIN_REFRESH_MS = 60_000;
const COUNTDOWN_MS = 60_000;

export class UsageWidgetController {
  private state: UsageWidgetState = { status: "no-model" };
  private providerId: string | undefined;
  private active: AbortController | undefined;
  private lastRefreshAt: number | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private countdownTimer: ReturnType<typeof setInterval> | undefined;
  private requestRender: (() => void) | undefined;
  private disposed = false;

  constructor(
    private ctx: ExtensionContext,
    private requests: Pick<UsageRequests, "get">,
  ) {
    ctx.ui.setWidget(
      "pix-usage",
      (tui) => {
        this.requestRender = () => tui.requestRender();
        return {
          invalidate() {},
          render: (width) =>
            this.disposed
              ? []
              : renderUsageWidget(this.state, width, this.ctx.ui.theme),
          // Pi may dispose the component before dispatching session_shutdown.
          dispose: () => this.stop(),
        };
      },
      { placement: "aboveEditor" },
    );
    this.selectProvider(ctx, ctx.model?.provider);
  }

  selectProvider(ctx: ExtensionContext, providerId: string | undefined): void {
    if (this.disposed) return;
    this.ctx = ctx;
    if (providerId === this.providerId) return;
    this.providerId = providerId;
    this.cancelRefresh();
    this.lastRefreshAt = undefined;
    const provider =
      providerId === "anthropic"
        ? "claude"
        : providerId === "openai-codex"
          ? "codex"
          : undefined;
    if (!provider) {
      this.state = {
        status: providerId === undefined ? "no-model" : "unsupported",
      };
      this.requestRender?.();
      return;
    }
    void this.refresh(provider);
    this.refreshTimer = setInterval(
      () => this.refreshCurrentProvider(),
      REFRESH_MS,
    );
    this.countdownTimer = setInterval(
      () => this.requestRender?.(),
      COUNTDOWN_MS,
    );
    this.refreshTimer.unref();
    this.countdownTimer.unref();
  }

  refreshCurrentProvider(ctx: ExtensionContext = this.ctx): void {
    if (this.disposed) return;
    // A timer may fire while an earlier async model_select handler is pending.
    this.selectProvider(ctx, ctx.model?.provider);
    if ("provider" in this.state) void this.refresh(this.state.provider);
  }

  private async refresh(provider: UsageProvider): Promise<void> {
    if (this.disposed || this.active) return;
    // Use a monotonic clock and count failed attempts too, avoiding retry bursts.
    const now = performance.now();
    if (
      this.lastRefreshAt !== undefined &&
      now - this.lastRefreshAt < MIN_REFRESH_MS
    )
      return;
    this.lastRefreshAt = now;
    const controller = new AbortController();
    this.active = controller;
    this.state = { status: "loading", provider };
    this.requestRender?.();
    try {
      const result = await this.requests.get(
        this.ctx.modelRegistry,
        provider,
        controller.signal,
      );
      if (
        this.disposed ||
        controller.signal.aborted ||
        this.active !== controller
      )
        return;
      // Selection may change before its model_select event reaches this extension.
      const providerId = this.ctx.model?.provider;
      if (providerId !== this.providerId) {
        this.selectProvider(this.ctx, providerId);
        return;
      }
      this.state = result;
      this.requestRender?.();
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }

  private cancelRefresh(): void {
    clearInterval(this.refreshTimer);
    clearInterval(this.countdownTimer);
    this.refreshTimer = undefined;
    this.countdownTimer = undefined;
    this.active?.abort();
    this.active = undefined;
  }

  private stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRefresh();
    this.requestRender = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.ctx.ui.setWidget("pix-usage", undefined);
  }
}
