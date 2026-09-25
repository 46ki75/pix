import { type FetchOptions, getJson } from "./http.ts";
import { UsageError, type UsageSnapshot, type UsageWindow } from "./types.ts";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function invalid(): never {
  throw new UsageError("response", "Unrecognized usage response.");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid();
  return value as Record<string, unknown>;
}

function nonnegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    invalid();
  return value;
}

function isoDate(milliseconds: number): string {
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) invalid();
  return date.toISOString();
}

function isoReset(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  // A timezone-less timestamp would silently use the machine's local timezone.
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    invalid();
  // Validate the source calendar date before applying its offset: Date.parse
  // silently normalizes impossible days such as February 30.
  const calendarDate = value.slice(0, 10);
  if (
    isoDate(Date.parse(`${calendarDate}T00:00:00Z`)).slice(0, 10) !==
    calendarDate
  )
    invalid();
  return isoDate(Date.parse(value));
}

const CLAUDE_WINDOWS = [
  ["five_hour", "5-hour", 5 * 3600],
  ["seven_day", "Weekly", 7 * 86400],
  ["seven_day_sonnet", "Sonnet weekly", 7 * 86400],
  ["seven_day_opus", "Opus weekly", 7 * 86400],
] as const;

export function parseClaudeUsage(payload: unknown): UsageWindow[] {
  const data = record(payload);
  if (!CLAUDE_WINDOWS.some(([key]) => Object.hasOwn(data, key))) invalid();
  const windows: UsageWindow[] = [];
  for (const [id, label, windowSeconds] of CLAUDE_WINDOWS) {
    const raw = data[id];
    if (raw === undefined || raw === null) continue;
    const bucket = record(raw);
    windows.push({
      id,
      label,
      usedPercent: nonnegative(bucket.utilization),
      resetsAt: isoReset(bucket.resets_at),
      windowSeconds,
    });
  }
  return windows;
}

function codexLabel(seconds: number | null, fallback: string): string {
  if (seconds === null) return fallback;
  if (seconds === 7 * 86400) return "Weekly";
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  if (seconds % 60 === 0) return `${seconds / 60}-minute`;
  return `${seconds}-second`;
}

export function parseCodexUsage(payload: unknown, now: number): UsageWindow[] {
  const data = record(payload);
  if (!Object.hasOwn(data, "rate_limit")) invalid();
  if (data.rate_limit === null) return [];
  const limits = record(data.rate_limit);
  if (
    !Object.hasOwn(limits, "primary_window") &&
    !Object.hasOwn(limits, "secondary_window")
  )
    invalid();
  const windows: UsageWindow[] = [];
  for (const [id, fallback] of [
    ["primary_window", "Primary"],
    ["secondary_window", "Secondary"],
  ] as const) {
    const raw = limits[id];
    if (raw === undefined || raw === null) continue;
    const bucket = record(raw);
    const seconds =
      bucket.limit_window_seconds == null
        ? null
        : nonnegative(bucket.limit_window_seconds);
    if (seconds === 0) invalid();
    let resetsAt: string | null = null;
    if (bucket.reset_at != null) {
      resetsAt = isoDate(nonnegative(bucket.reset_at) * 1000);
    } else if (bucket.reset_after_seconds != null) {
      resetsAt = isoDate(now + nonnegative(bucket.reset_after_seconds) * 1000);
    }
    windows.push({
      id,
      label: codexLabel(seconds, fallback),
      usedPercent: nonnegative(bucket.used_percent),
      resetsAt,
      windowSeconds: seconds,
    });
  }
  return windows;
}

export function codexAccountId(accessToken: string): string {
  try {
    const parts = accessToken.split(".");
    const payload = parts[1];
    if (parts.length !== 3 || !payload || !/^[\w-]+$/.test(payload))
      throw new Error();
    const claims = record(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    const auth = record(claims["https://api.openai.com/auth"]);
    const accountId = auth.chatgpt_account_id;
    if (
      typeof accountId !== "string" ||
      !/^[\x21-\x7e]{1,512}$/.test(accountId)
    )
      throw new Error();
    // Same account selection as Pi's Codex transport. This decodes routing
    // metadata only; the provider, not this decoder, authenticates the JWT.
    return accountId;
  } catch {
    throw new UsageError(
      "auth",
      "Codex account ID is unavailable; sign in again with /login openai-codex.",
    );
  }
}

function authorization(accessToken: string): string {
  if (!accessToken || /\s/.test(accessToken)) {
    throw new UsageError("auth", "Invalid subscription access token.");
  }
  return `Bearer ${accessToken}`;
}

export async function fetchClaudeUsage(
  accessToken: string,
  options: FetchOptions = {},
): Promise<UsageSnapshot> {
  const payload = await getJson(
    CLAUDE_USAGE_URL,
    {
      Authorization: authorization(accessToken),
      "anthropic-beta": "oauth-2025-04-20",
    },
    options,
  );
  return {
    provider: "claude",
    fetchedAt: new Date().toISOString(),
    windows: parseClaudeUsage(payload),
  };
}

export async function fetchCodexUsage(
  accessToken: string,
  options: FetchOptions = {},
): Promise<UsageSnapshot> {
  const payload = await getJson(
    CODEX_USAGE_URL,
    {
      Authorization: authorization(accessToken),
      "chatgpt-account-id": codexAccountId(accessToken),
    },
    options,
  );
  const now = Date.now();
  return {
    provider: "codex",
    fetchedAt: isoDate(now),
    windows: parseCodexUsage(payload, now),
  };
}
