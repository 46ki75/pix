export type UsageProvider = "claude" | "codex";

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  windowSeconds: number | null;
}

export interface UsageSnapshot {
  provider: UsageProvider;
  fetchedAt: string;
  windows: UsageWindow[];
}

export type UsageResult =
  | { provider: UsageProvider; status: "ok"; usage: UsageSnapshot }
  | {
      provider: UsageProvider;
      status: "unavailable" | "error";
      message: string;
    };

export class UsageError extends Error {
  constructor(
    readonly code:
      | "auth"
      | "http"
      | "rate-limit"
      | "network"
      | "response"
      | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "UsageError";
  }
}
