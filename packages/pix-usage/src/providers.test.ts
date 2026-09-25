import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CLAUDE_USAGE_URL,
  CODEX_USAGE_URL,
  codexAccountId,
  fetchClaudeUsage,
  fetchCodexUsage,
  parseClaudeUsage,
  parseCodexUsage,
} from "./providers.ts";

const NOW = Date.parse("2026-09-25T00:00:00Z");
const RESET = "2026-09-25T05:00:00.000Z";
const token = (payload: unknown) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
const CODEX_TOKEN = token({
  "https://api.openai.com/auth": { chatgpt_account_id: "account-test" },
});

afterEach(() => vi.useRealTimers());

describe("Claude payloads", () => {
  test("preserves known windows, zero usage, and an unknown reset", () => {
    expect(
      parseClaudeUsage({
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 75.25, resets_at: RESET },
        seven_day_sonnet: null,
        seven_day_opus: { utilization: 101, resets_at: RESET },
        unknown_new_field: "ignored",
      }),
    ).toEqual([
      {
        id: "five_hour",
        label: "5-hour",
        usedPercent: 0,
        resetsAt: null,
        windowSeconds: 18000,
      },
      {
        id: "seven_day",
        label: "Weekly",
        usedPercent: 75.25,
        resetsAt: RESET,
        windowSeconds: 604800,
      },
      {
        id: "seven_day_opus",
        label: "Opus weekly",
        usedPercent: 101,
        resetsAt: RESET,
        windowSeconds: 604800,
      },
    ]);
  });

  test.each([
    ["2026-09-25T14:00:00.123456+09:00", "2026-09-25T05:00:00.123Z"],
    ["2026-03-01T00:30:00+01:00", "2026-02-28T23:30:00.000Z"],
    ["2024-02-29T23:30:00-02:00", "2024-03-01T01:30:00.000Z"],
    ["2000-02-29T00:00:00Z", "2000-02-29T00:00:00.000Z"],
    ["0000-02-29T00:00:00Z", "0000-02-29T00:00:00.000Z"],
    // 24:00 denotes end-of-day midnight, not an impossible calendar date:
    // https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-date-time-string-format
    ["2026-01-01T24:00:00Z", "2026-01-02T00:00:00.000Z"],
    ["2024-02-29T24:00:00+09:00", "2024-02-29T15:00:00.000Z"],
  ])(
    "normalizes valid calendar dates and offsets: %s",
    (resets_at, expected) => {
      expect(
        parseClaudeUsage({ five_hour: { utilization: 0, resets_at } })[0]
          ?.resetsAt,
      ).toBe(expected);
    },
  );

  test.each([
    "2026-02-29T05:00:00Z",
    "2026-02-30T05:00:00Z",
    "2024-02-30T05:00:00+09:00",
    "2026-04-31T23:30:00-02:00",
    "2026-06-31T00:30:00+01:00",
    "1900-02-29T00:00:00Z",
    "2100-02-29T00:00:00Z",
    "2026-01-01T24:01:00Z",
    "2026-01-01T24:00:01Z",
    "2026-01-01T24:00:00.001Z",
  ])("rejects impossible calendar dates and times: %s", (resets_at) => {
    expect(() =>
      parseClaudeUsage({ five_hour: { utilization: 10, resets_at } }),
    ).toThrow("Unrecognized usage response.");
  });

  test("supports weekly-only, Sonnet, and explicitly absent quotas", () => {
    expect(
      parseClaudeUsage({
        five_hour: null,
        seven_day: { utilization: 20, resets_at: RESET },
      }),
    ).toMatchObject([{ label: "Weekly", usedPercent: 20 }]);
    expect(
      parseClaudeUsage({ seven_day_sonnet: { utilization: 4 } }),
    ).toMatchObject([{ label: "Sonnet weekly", resetsAt: null }]);
    expect(parseClaudeUsage({ five_hour: null, seven_day: null })).toEqual([]);
  });

  test.each([
    null,
    [],
    {},
    { extra_usage: {} },
    { five_hour: [] },
    { five_hour: {} },
    { five_hour: { utilization: "25" } },
    { five_hour: { utilization: Number.NaN } },
    { five_hour: { utilization: Number.POSITIVE_INFINITY } },
    { five_hour: { utilization: -1 } },
    { five_hour: { utilization: 2, resets_at: "secret\u001b[31m" } },
    { five_hour: { utilization: 2, resets_at: 123 } },
    { five_hour: { utilization: 2, resets_at: "2026-09-25T05:00:00" } },
  ])("rejects malformed quota data without echoing it: %j", (payload) => {
    expect(() => parseClaudeUsage(payload)).toThrow(
      "Unrecognized usage response.",
    );
  });
});

describe("Codex payloads", () => {
  test("uses reported duration, including a weekly primary window", () => {
    expect(
      parseCodexUsage(
        {
          rate_limit: {
            primary_window: {
              used_percent: 75,
              limit_window_seconds: 604800,
              reset_at: NOW / 1000 + 604800,
            },
            secondary_window: null,
          },
        },
        NOW,
      ),
    ).toEqual([
      {
        id: "primary_window",
        label: "Weekly",
        usedPercent: 75,
        windowSeconds: 604800,
        resetsAt: "2026-10-02T00:00:00.000Z",
      },
    ]);
  });

  test("normalizes both windows and uses relative reset only as a fallback", () => {
    expect(
      parseCodexUsage(
        {
          rate_limit: {
            primary_window: {
              used_percent: 0,
              limit_window_seconds: 18000,
              reset_at: NOW / 1000 + 18000,
              reset_after_seconds: 99,
            },
            secondary_window: {
              used_percent: 25.5,
              limit_window_seconds: 604800,
              reset_after_seconds: 3600,
            },
          },
        },
        NOW,
      ),
    ).toEqual([
      {
        id: "primary_window",
        label: "5-hour",
        usedPercent: 0,
        windowSeconds: 18000,
        resetsAt: RESET,
      },
      {
        id: "secondary_window",
        label: "Weekly",
        usedPercent: 25.5,
        windowSeconds: 604800,
        resetsAt: "2026-09-25T01:00:00.000Z",
      },
    ]);
  });

  test("never guesses missing durations or reset times", () => {
    expect(
      parseCodexUsage(
        {
          rate_limit: {
            primary_window: { used_percent: 10 },
            secondary_window: { used_percent: 0, limit_window_seconds: 18000 },
          },
        },
        NOW,
      ),
    ).toMatchObject([
      { label: "Primary", windowSeconds: null, resetsAt: null },
      { label: "5-hour", resetsAt: null },
    ]);
    expect(parseCodexUsage({ rate_limit: null }, NOW)).toEqual([]);
    expect(
      parseCodexUsage({ rate_limit: { primary_window: null } }, NOW),
    ).toEqual([]);
  });

  test.each([
    [900, "15-minute"],
    [30, "30-second"],
    [86400, "24-hour"],
  ] as const)("labels a %s-second window", (seconds, label) => {
    expect(
      parseCodexUsage(
        {
          rate_limit: {
            primary_window: { used_percent: 2, limit_window_seconds: seconds },
          },
        },
        NOW,
      )[0]?.label,
    ).toBe(label);
  });

  test.each([
    null,
    [],
    {},
    { rate_limit: [] },
    { rate_limit: {} },
    { rate_limit: { primary_window: {} } },
    { rate_limit: { primary_window: { used_percent: "2" } } },
    { rate_limit: { primary_window: { used_percent: -1 } } },
    {
      rate_limit: {
        primary_window: { used_percent: 2, limit_window_seconds: 0 },
      },
    },
    {
      rate_limit: {
        primary_window: { used_percent: 2, limit_window_seconds: "18000" },
      },
    },
    { rate_limit: { primary_window: { used_percent: 2, reset_at: -1 } } },
    { rate_limit: { primary_window: { used_percent: 2, reset_at: 1e100 } } },
    {
      rate_limit: {
        primary_window: { used_percent: 2, reset_after_seconds: "60" },
      },
    },
  ])("rejects malformed quota data: %j", (payload) => {
    expect(() => parseCodexUsage(payload, NOW)).toThrow(
      "Unrecognized usage response.",
    );
  });
});

test("extracts only the Codex account routing claim", () => {
  expect(codexAccountId(CODEX_TOKEN)).toBe("account-test");
  for (const value of [
    "secret",
    "a.bad!.b",
    token({}),
    token({
      "https://api.openai.com/auth": { chatgpt_account_id: "bad\r\nheader" },
    }),
  ]) {
    expect(() => codexAccountId(value)).toThrow(
      "Codex account ID is unavailable",
    );
  }
});

test("fetchers accept tokens without Pi and make the documented read-only requests", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({ five_hour: { utilization: 12, resets_at: RESET } }),
    )
    .mockResolvedValueOnce(
      Response.json({
        rate_limit: {
          primary_window: { used_percent: 5, reset_after_seconds: 18000 },
        },
      }),
    );
  const claude = await fetchClaudeUsage("claude-test-token", { fetch });
  const codex = await fetchCodexUsage(CODEX_TOKEN, { fetch });
  expect(claude).toMatchObject({
    provider: "claude",
    fetchedAt: "2026-09-25T00:00:00.000Z",
    windows: [{ usedPercent: 12 }],
  });
  expect(codex).toMatchObject({
    provider: "codex",
    fetchedAt: claude.fetchedAt,
    windows: [{ usedPercent: 5, resetsAt: RESET }],
  });
  expect(fetch).toHaveBeenNthCalledWith(
    1,
    CLAUDE_USAGE_URL,
    expect.objectContaining({
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer claude-test-token",
        "anthropic-beta": "oauth-2025-04-20",
      },
    }),
  );
  expect(fetch).toHaveBeenNthCalledWith(
    2,
    CODEX_USAGE_URL,
    expect.objectContaining({
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${CODEX_TOKEN}`,
        "chatgpt-account-id": "account-test",
      },
    }),
  );
});

test("invalid tokens never reach the network", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  await expect(fetchClaudeUsage("", { fetch })).rejects.toThrow(
    "Invalid subscription access token",
  );
  await expect(fetchClaudeUsage("token\r\nheader", { fetch })).rejects.toThrow(
    "Invalid subscription access token",
  );
  await expect(fetchCodexUsage("not-a-jwt", { fetch })).rejects.toThrow(
    "Codex account ID is unavailable",
  );
  expect(fetch).not.toHaveBeenCalled();
});
