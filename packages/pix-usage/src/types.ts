export type UsageProvider =
  | "claude"
  | "codex"
  | "muse"
  | "opencode"
  | "copilot";

export interface UsageAmount {
  used: number;
  total: number | null;
  unit: "credits" | "requests";
  estimated: boolean;
}

export interface UsageWindow {
  id: string;
  label: string;
  // Null means no meaningful ratio, not zero consumption.
  usedPercent: number | null;
  amount?: UsageAmount;
  quotaState?: "unlimited" | "unavailable";
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
