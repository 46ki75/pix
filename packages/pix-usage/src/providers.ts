import { type FetchOptions, getJson, postJson } from "./http.ts";
import { UsageError, type UsageSnapshot, type UsageWindow } from "./types.ts";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const MUSE_USAGE_URL = "https://api.meta.ai/muse-code/key";
export const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";

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

function optionalBoolean(
  data: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") invalid();
  return value;
}

function epochReset(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) invalid();
  if (value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Go defines fixed five-hour and weekly limits. Its monthly reset follows the
// subscription date, so the response's reset timestamp is authoritative and no
// fixed monthly duration is inferred.
const OPENCODE_WINDOWS = [
  ["rolling", "5-hour", 5 * 3600],
  ["weekly", "Weekly", 7 * 86400],
  ["monthly", "Monthly", null],
] as const;

export function parseOpenCodeUsage(payload: unknown): UsageWindow[] {
  const data = record(payload);
  const usage = record(data.usage);
  return OPENCODE_WINDOWS.map(([id, label, windowSeconds]) => {
    const bucket = record(usage[id]);
    if (bucket.status !== "ok" && bucket.status !== "rate-limited") invalid();
    const usedPercent = nonnegative(bucket.percent);
    if (
      usedPercent > 100 ||
      (bucket.status === "rate-limited") !== (usedPercent === 100)
    )
      invalid();
    const resetsAt = isoReset(bucket.resetsAt);
    if (resetsAt === null) invalid();
    return { id, label, usedPercent, resetsAt, windowSeconds };
  });
}

export function parseMuseUsage(payload: unknown): UsageWindow[] {
  const data = record(payload);
  const requiresPayment = optionalBoolean(data, "require_payment");
  const active = optionalBoolean(data, "is_subs_active");
  if (requiresPayment) {
    throw new UsageError(
      "auth",
      "Meta Muse requires a payment method; finish setup at dev.meta.ai.",
    );
  }
  if (active !== true) {
    throw new UsageError(
      "auth",
      "No active Meta Muse subscription was found for this login.",
    );
  }
  // Meta can omit this object while the rolling window is idle, even when the
  // weekly limit has usage. Preserve that as unknown rather than inventing zeroes.
  if (data.subs_usage === undefined || data.subs_usage === null) return [];

  const usage = record(data.subs_usage);
  const primary = record(usage.window);
  const weekly = record(usage.weekly);
  const minutes = nonnegative(primary.window_duration_mins);
  const windowSeconds = Math.round(minutes) * 60;
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds <= 0) invalid();
  return [
    {
      id: "window",
      label: codexLabel(windowSeconds, "Primary"),
      usedPercent: nonnegative(primary.used_percent),
      resetsAt: epochReset(primary.resets_at),
      windowSeconds,
    },
    {
      id: "weekly",
      label: "Weekly",
      usedPercent: nonnegative(weekly.used_percent),
      resetsAt: epochReset(weekly.resets_at),
      windowSeconds: 7 * 86400,
    },
  ];
}

function copilotCounter(value: unknown): number {
  const count = nonnegative(value);
  if (count > Number.MAX_SAFE_INTEGER) invalid();
  return count;
}

function copilotEntitlement(value: unknown, unlimited: boolean): number | null {
  if (value == null) return null;
  if (unlimited && (value === -1 || value === "-1")) return null;
  if (typeof value === "string") {
    if (!/^\d+(?:\.\d+)?$/.test(value)) invalid();
    return copilotCounter(Number(value));
  }
  return copilotCounter(value);
}

function copilotReset(
  data: Record<string, unknown>,
  bucket: Record<string, unknown>,
): string | null {
  // A category-specific reset must not borrow a different quota's account clock.
  if (bucket.quota_reset_at != null) return epochReset(bucket.quota_reset_at);
  if (data.quota_reset_date_utc != null)
    return isoReset(data.quota_reset_date_utc);
  const legacy = data.quota_reset_date ?? data.limited_user_reset_date;
  // Date-only legacy values contain no clock. Do not turn them into countdowns.
  if (typeof legacy === "string" && /^\d{4}-\d{2}-\d{2}$/.test(legacy)) {
    isoReset(`${legacy}T00:00:00Z`);
    return null;
  }
  return isoReset(legacy);
}

export function parseCopilotUsage(payload: unknown): UsageWindow[] {
  const data = record(payload);
  const credits = optionalBoolean(data, "token_based_billing") === true;
  if (!Object.hasOwn(data, "quota_snapshots")) invalid();
  if (data.quota_snapshots == null) return [];
  const snapshots = record(data.quota_snapshots);
  // Free seats use chat even when a placeholder premium snapshot omits its zero
  // entitlement. Match VS Code's Free SKU selection; do not infer allocation
  // from the placeholder's percentage. Never sum potentially overlapping pools.
  const free =
    data.access_type_sku === "free_limited_copilot" ||
    data.copilot_plan === "free";
  const ids = free
    ? (["chat"] as const)
    : (["premium_interactions", "chat"] as const);
  for (const id of ids) {
    if (snapshots[id] == null) continue;
    const bucket = record(snapshots[id]);
    const unlimited = optionalBoolean(bucket, "unlimited");
    if (unlimited === undefined) invalid();
    const total = copilotEntitlement(bucket.entitlement, unlimited);
    const hasQuota = optionalBoolean(bucket, "has_quota");
    const overage = optionalBoolean(bucket, "overage_permitted");
    if (!unlimited && total === 0) continue;
    const window: UsageWindow = {
      id,
      label: credits
        ? "AI credits"
        : id === "premium_interactions"
          ? "Premium"
          : "Chat",
      usedPercent: null,
      resetsAt: copilotReset(data, bucket),
      windowSeconds: null,
    };
    if (unlimited) {
      window.quotaState =
        hasQuota === false && overage !== true ? "unavailable" : "unlimited";
      // credits_used is an aggregate without a denominator. It is NOT the used
      // portion of entitlement. See VS Code's getQuotaUsage at commit
      // 959031245ebb1fe077e0d512e1397c0ae82006e4, chatEntitlementService.ts.
      if (credits && bucket.credits_used != null) {
        window.amount = {
          used: copilotCounter(bucket.credits_used),
          total: null,
          unit: "credits",
          estimated: false,
        };
      }
    } else {
      const remainingPercent = nonnegative(bucket.percent_remaining);
      if (remainingPercent > 100) invalid();
      window.usedPercent = 100 - remainingPercent;
      const remaining =
        bucket.quota_remaining == null
          ? null
          : copilotCounter(bucket.quota_remaining);
      if (total !== null) {
        window.amount = {
          used:
            remaining === null
              ? (total * window.usedPercent) / 100
              : Math.max(0, total - remaining),
          total,
          unit: credits ? "credits" : "requests",
          estimated: remaining === null,
        };
      }
    }
    return [window];
  }
  return [];
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

function museAuthorization(identityToken: string): string {
  if (!/^dca:\S+$/.test(identityToken)) {
    throw new UsageError(
      "auth",
      "Meta Muse usage requires a device-code OAuth login; use /login meta.",
    );
  }
  return `Bearer ${identityToken}`;
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

export async function fetchOpenCodeUsage(
  apiKey: string,
  options: FetchOptions = {},
): Promise<UsageSnapshot> {
  const payload = await getJson(
    OPENCODE_USAGE_URL,
    { Authorization: authorization(apiKey) },
    options,
  );
  return {
    provider: "opencode",
    fetchedAt: new Date().toISOString(),
    windows: parseOpenCodeUsage(payload),
  };
}

export async function fetchCopilotUsage(
  githubToken: string,
  options: FetchOptions = {},
): Promise<UsageSnapshot> {
  if (
    !githubToken ||
    /[^\x21-\x7e]/.test(githubToken) ||
    githubToken.startsWith("!")
  ) {
    throw new UsageError("auth", "Invalid GitHub OAuth token.");
  }
  const payload = await getJson(
    COPILOT_USAGE_URL,
    {
      Authorization: `token ${githubToken}`,
      "X-GitHub-Api-Version": "2025-04-01",
    },
    options,
  );
  return {
    provider: "copilot",
    fetchedAt: new Date().toISOString(),
    windows: parseCopilotUsage(payload),
  };
}

export async function fetchMuseUsage(
  identityToken: string,
  options: FetchOptions = {},
): Promise<UsageSnapshot> {
  const payload = await postJson(
    MUSE_USAGE_URL,
    {
      Authorization: museAuthorization(identityToken),
      "x-api-version": "1.0.0",
    },
    options,
  );
  return {
    provider: "muse",
    fetchedAt: new Date().toISOString(),
    windows: parseMuseUsage(payload),
  };
}
