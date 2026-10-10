import { afterEach, expect, test, vi } from "vitest";
import { fetchCopilotUsage, parseCopilotUsage } from "./providers.ts";

const RESET = "2026-11-01T00:00:00.000Z";
function payload(
  snapshot: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    token_based_billing: true,
    quota_reset_date_utc: RESET,
    quota_snapshots: {
      premium_interactions: {
        unlimited: false,
        entitlement: "1500",
        quota_remaining: 1080,
        percent_remaining: 72,
        ...snapshot,
      },
    },
    ...extra,
  };
}

afterEach(() => vi.useRealTimers());

test("uses matching quota counters, not aggregate credits or extra usage", () => {
  expect(
    parseCopilotUsage(payload({ credits_used: 9999, overage_count: 42 })),
  ).toEqual([
    {
      id: "premium_interactions",
      label: "AI credits",
      usedPercent: 28,
      amount: { used: 420, total: 1500, unit: "credits", estimated: false },
      resetsAt: RESET,
      windowSeconds: null,
    },
  ]);
});

test("marks a percentage-derived amount approximate and does not use legacy remaining", () => {
  expect(
    parseCopilotUsage(payload({ quota_remaining: undefined, remaining: 1 }))[0],
  ).toMatchObject({
    amount: { used: 420, total: 1500, unit: "credits", estimated: true },
  });
});

test.each([false, undefined])(
  "uses requests for legacy billing %s",
  (token_based_billing) => {
    expect(
      parseCopilotUsage(payload({}, { token_based_billing }))[0],
    ).toMatchObject({
      label: "Premium",
      amount: { unit: "requests" },
    });
  },
);

test("top-level billing mode wins over a conflicting snapshot flag", () => {
  expect(
    parseCopilotUsage(payload({ token_based_billing: false }))[0]?.amount?.unit,
  ).toBe("credits");
});

test.each([0, 100])(
  "preserves %s percent remaining including exhausted quota",
  (percent_remaining) => {
    expect(
      parseCopilotUsage(
        payload({
          percent_remaining,
          quota_remaining: percent_remaining * 15,
          has_quota: false,
        }),
      )[0],
    ).toMatchObject({
      usedPercent: 100 - percent_remaining,
      amount: { used: 1500 - percent_remaining * 15 },
    });
  },
);

test("accepts fractional counters and numeric entitlements", () => {
  expect(
    parseCopilotUsage(
      payload({ entitlement: 1500.5, quota_remaining: 1080.25 }),
    )[0]?.amount,
  ).toEqual({ used: 420.25, total: 1500.5, unit: "credits", estimated: false });
});

test("does not produce negative consumption when an allowance changes", () => {
  expect(
    parseCopilotUsage(payload({ quota_remaining: 1600 }))[0]?.amount?.used,
  ).toBe(0);
});

test("retains percentages without inventing a missing denominator", () => {
  const window = parseCopilotUsage(
    payload({ entitlement: undefined, credits_used: 33 }),
  )[0];
  expect(window?.usedPercent).toBe(28);
  expect(window?.amount).toBeUndefined();
});

test("unlimited pooled credits have no percentage or denominator", () => {
  expect(
    parseCopilotUsage(
      payload({
        unlimited: true,
        entitlement: "-1",
        credits_used: 420,
        has_quota: true,
      }),
    )[0],
  ).toMatchObject({
    usedPercent: null,
    quotaState: "unlimited",
    amount: { used: 420, total: null, unit: "credits", estimated: false },
  });
});

test("does not invent usage for unlimited accounts without a credit counter", () => {
  const window = parseCopilotUsage(
    payload({ unlimited: true, entitlement: "0" }),
  )[0];
  expect(window).toMatchObject({ usedPercent: null, quotaState: "unlimited" });
  expect(window?.amount).toBeUndefined();
});

test("preserves depleted pool state without calling it zero usage or unlimited access", () => {
  expect(
    parseCopilotUsage(
      payload({
        unlimited: true,
        has_quota: false,
        overage_permitted: false,
        credits_used: 0,
      }),
    )[0],
  ).toMatchObject({
    usedPercent: null,
    quotaState: "unavailable",
    amount: { used: 0, total: null },
  });
});

test("additional usage permission is not a credit allowance", () => {
  expect(
    parseCopilotUsage(
      payload({
        unlimited: true,
        has_quota: false,
        overage_permitted: true,
        credits_used: 1,
      }),
    )[0],
  ).toMatchObject({ quotaState: "unlimited", amount: { total: null } });
});

test("falls back to Free chat when premium has zero allocation; never sums duplicated pools", () => {
  const chat = {
    unlimited: false,
    entitlement: "200",
    quota_remaining: 150,
    percent_remaining: 75,
  };
  expect(
    parseCopilotUsage(
      payload(
        {},
        {
          quota_snapshots: {
            premium_interactions: {
              unlimited: false,
              entitlement: "0",
              percent_remaining: 0,
            },
            chat,
            completions: { ...chat, entitlement: "2000" },
          },
        },
      ),
    ),
  ).toMatchObject([
    { id: "chat", label: "AI credits", amount: { used: 50, total: 200 } },
  ]);
  expect(
    parseCopilotUsage(
      payload(
        {},
        {
          quota_snapshots: {
            premium_interactions: chat,
            chat,
            completions: chat,
          },
        },
      ),
    ),
  ).toHaveLength(1);
});

test.each([true, false])(
  "known Free accounts select chat, not a placeholder premium percentage (credits: %s)",
  (token_based_billing) => {
    const windows = parseCopilotUsage({
      access_type_sku: "free_limited_copilot",
      copilot_plan: "free",
      token_based_billing,
      quota_snapshots: {
        chat: { unlimited: false, percent_remaining: 60 },
        premium_interactions: { unlimited: false, percent_remaining: 0 },
      },
    });
    expect(windows).toMatchObject([
      {
        id: "chat",
        usedPercent: 40,
        label: token_based_billing ? "AI credits" : "Chat",
      },
    ]);
  },
);

test("missing Free chat is unknown, not a substitute premium allowance", () => {
  expect(parseCopilotUsage(payload({}, { copilot_plan: "free" }))).toEqual([]);
});

test("legacy Free chat is labeled Chat, not Premium", () => {
  expect(
    parseCopilotUsage({
      quota_snapshots: { chat: { unlimited: false, percent_remaining: 60 } },
    })[0],
  ).toMatchObject({ label: "Chat", usedPercent: 40 });
});

test.each([
  null,
  {},
  { premium_interactions: null },
  { completions: { unlimited: true } },
])("allows explicitly absent supported quotas: %j", (quota_snapshots) => {
  expect(parseCopilotUsage({ quota_snapshots })).toEqual([]);
});

test("per-category reset has priority over the account timestamp", () => {
  expect(
    parseCopilotUsage(
      payload({ quota_reset_at: Date.parse("2026-10-20T12:00:00Z") / 1000 }),
    )[0]?.resetsAt,
  ).toBe("2026-10-20T12:00:00.000Z");
});

test("uses a timezone-bearing legacy reset but never fabricates a clock from a date", () => {
  expect(
    parseCopilotUsage(
      payload(
        {},
        {
          quota_reset_date_utc: undefined,
          quota_reset_date: "2026-11-01T09:00:00+09:00",
        },
      ),
    )[0]?.resetsAt,
  ).toBe(RESET);
  expect(
    parseCopilotUsage(
      payload(
        {},
        { quota_reset_date_utc: undefined, quota_reset_date: "2026-11-01" },
      ),
    )[0]?.resetsAt,
  ).toBeNull();
  expect(
    parseCopilotUsage(payload({}, { quota_reset_date_utc: undefined }))[0]
      ?.resetsAt,
  ).toBeNull();
});

test.each([undefined, null, 0])(
  "an absent category reset %s falls back to the account timestamp",
  (quota_reset_at) => {
    expect(parseCopilotUsage(payload({ quota_reset_at }))[0]).toMatchObject({
      resetsAt: RESET,
    });
  },
);

test.each([
  "quota_reset_date_utc",
  "quota_reset_date",
  "limited_user_reset_date",
])("preserves a calendar-only %s without inventing a timestamp", (field) => {
  for (const quota_reset_at of [undefined, null, 0]) {
    const value = parseCopilotUsage(
      payload(
        { quota_reset_at },
        {
          quota_reset_date_utc: undefined,
          [field]: "2026-11-01",
        },
      ),
    )[0];
    expect(value).toMatchObject({ resetsAt: null, resetsOn: "2026-11-01" });
  }
});

test.each([
  "2026-02-30",
  "2026-02-29",
  "2026-04-31",
  "2026-13-01",
  "2026-00-01",
  "2026-11-00",
  "2026-11-1",
  "2026-11-01\u001b[31m",
])("rejects invalid or unsafe calendar-only reset %j", (quota_reset_date) => {
  expect(() =>
    parseCopilotUsage(
      payload({}, { quota_reset_date_utc: undefined, quota_reset_date }),
    ),
  ).toThrow("Unrecognized usage response.");
});

test("preserves leap-day calendar resets and account field precedence", () => {
  expect(
    parseCopilotUsage(
      payload(
        {},
        {
          quota_reset_date_utc: undefined,
          quota_reset_date: "2028-02-29",
          limited_user_reset_date: "2028-03-01",
        },
      ),
    )[0],
  ).toMatchObject({ resetsAt: null, resetsOn: "2028-02-29" });
  const precise = parseCopilotUsage(
    payload({}, { quota_reset_date: "2026-12-01" }),
  )[0];
  expect(precise?.resetsAt).toBe(RESET);
  expect(precise).not.toHaveProperty("resetsOn");
});

test("a category timestamp wins over an account-only date", () => {
  const precise = parseCopilotUsage(
    payload(
      { quota_reset_at: Date.parse("2026-10-20T12:00:00Z") / 1000 },
      {
        quota_reset_date_utc: undefined,
        quota_reset_date: "2026-11-01",
      },
    ),
  )[0];
  expect(precise?.resetsAt).toBe("2026-10-20T12:00:00.000Z");
  expect(precise).not.toHaveProperty("resetsOn");
});

test("zero category reset without an account date remains unknown", () => {
  const value = parseCopilotUsage(
    payload({ quota_reset_at: 0 }, { quota_reset_date_utc: undefined }),
  )[0];
  expect(value?.resetsAt).toBeNull();
  expect(value).not.toHaveProperty("resetsOn");
});

test.each([-1, 1e20])(
  "an unusable nonzero category reset %s does not borrow a different quota's clock",
  (quota_reset_at) => {
    expect(
      parseCopilotUsage(payload({ quota_reset_at }))[0]?.resetsAt,
    ).toBeNull();
  },
);

test.each([
  {},
  null,
  [],
  { quota_snapshots: [] },
  payload({ unlimited: "false" }),
  payload({ unlimited: undefined }),
  payload({ percent_remaining: -1 }),
  payload({ percent_remaining: 101 }),
  payload({ percent_remaining: NaN }),
  payload({ percent_remaining: "72" }),
  payload({ percent_remaining: undefined }),
  payload({ entitlement: "" }),
  payload({ entitlement: " " }),
  payload({ entitlement: "1e3" }),
  payload({ entitlement: "0x10" }),
  payload({ entitlement: -1 }),
  payload({ entitlement: Infinity }),
  payload({ entitlement: Number.MAX_SAFE_INTEGER + 1 }),
  payload({ quota_remaining: -1 }),
  payload({ quota_remaining: "100" }),
  payload({ quota_remaining: Infinity }),
  payload({ unlimited: true, credits_used: -1 }),
  payload({ unlimited: true, credits_used: "420" }),
  payload({ has_quota: "true" }),
  payload({ overage_permitted: 1 }),
  payload({ quota_reset_at: "123" }),
  payload({}, { token_based_billing: "true" }),
  payload({}, { quota_reset_date_utc: "2026-02-30T00:00:00Z" }),
  payload({}, { quota_reset_date_utc: "2026-11-01T00:00:00" }),
])("rejects malformed payloads safely: %#", (data) => {
  expect(() => parseCopilotUsage(data)).toThrow("Unrecognized usage response.");
});

test("fetches only the fixed quota endpoint with the GitHub token and sanitized output", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      ...payload(),
      copilot_plan: "SECRET_PLAN",
      organization_login_list: ["SECRET_ORG"],
    }),
  );
  const result = await fetchCopilotUsage("github-test-oauth-token", { fetch });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://api.github.com/copilot_internal/user",
    expect.objectContaining({
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: "token github-test-oauth-token",
        "X-GitHub-Api-Version": "2025-04-01",
      },
    }),
  );
  expect(result).toMatchObject({
    provider: "copilot",
    fetchedAt: "2026-10-10T00:00:00.000Z",
    windows: [{ amount: { used: 420 } }],
  });
  expect(JSON.stringify(result)).not.toMatch(/SECRET|github-test-oauth-token/);
});

test.each(["", "bad token", "bad\ntoken", "!command"])(
  "rejects invalid tokens before fetching: %#",
  async (token) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(fetchCopilotUsage(token, { fetch })).rejects.toThrow(
      "Invalid GitHub OAuth token.",
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each([401, 403, 429, 500])(
  "sanitizes HTTP %s failures",
  async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("secret-token", { status }));
    await expect(fetchCopilotUsage("test-token", { fetch })).rejects.toThrow(
      `HTTP ${status}`,
    );
    await expect(
      fetchCopilotUsage("test-token", { fetch }),
    ).rejects.not.toThrow("secret-token");
  },
);
