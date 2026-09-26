import { resolveUsage } from "./auth.ts";
import { abortable } from "./http.ts";
import type { UsageProvider, UsageResult } from "./types.ts";

const USAGE_TIMEOUT_MS = 20_000;

type Registry = Parameters<typeof resolveUsage>[0];
interface PendingUsage {
  controller: AbortController;
  result: Promise<UsageResult>;
  consumers: number;
}

export class UsageRequests {
  private pending = new Map<UsageProvider, PendingUsage>();

  async get(
    registry: Registry,
    provider: UsageProvider,
    signal: AbortSignal,
  ): Promise<UsageResult> {
    const cancelled: UsageResult = {
      provider,
      status: "error",
      message: "Usage request cancelled or timed out.",
    };
    if (signal.aborted) return cancelled;
    let request = this.pending.get(provider);
    if (!request) {
      const controller = new AbortController();
      request = {
        controller,
        consumers: 0,
        result: resolveUsage(
          registry,
          provider,
          AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(USAGE_TIMEOUT_MS),
          ]),
        ),
      };
      this.pending.set(provider, request);
      const current = request;
      // Share in-flight work, not completed snapshots: /usage remains on-demand.
      void request.result.then(() => {
        if (this.pending.get(provider) === current)
          this.pending.delete(provider);
      });
    }
    request.consumers++;
    try {
      return await abortable(request.result, signal);
    } catch {
      return cancelled;
    } finally {
      request.consumers--;
      // Hiding the widget must not cancel an overlapping manual report.
      if (request.consumers === 0 && this.pending.get(provider) === request) {
        this.pending.delete(provider);
        request.controller.abort();
      }
    }
  }

  cancelAll(): void {
    for (const request of this.pending.values()) request.controller.abort();
    this.pending.clear();
  }
}
