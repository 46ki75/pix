import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { resolveUsage } from "./auth.ts";

type ResolveAuth = ExtensionContext["modelRegistry"]["getProviderAuth"];
const signal = () => new AbortController().signal;
const jwt = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;

afterEach(() => vi.unstubAllGlobals());

test.each([
  ["claude", "anthropic", "access-token", { five_hour: { utilization: 0 } }],
  [
    "codex",
    "openai-codex",
    jwt,
    { rate_limit: { primary_window: { used_percent: 20 } } },
  ],
] as const)(
  "uses Pi's resolved %s access token, not a credential file",
  async (provider, piId, token, payload) => {
    const getProviderAuth = vi.fn<ResolveAuth>().mockResolvedValue({
      source: "OAuth",
      auth: {
        apiKey: token,
        headers: { "x-model-secret": "must-not-forward" },
      },
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(payload));
    vi.stubGlobal("fetch", fetch);
    expect(
      await resolveUsage({ getProviderAuth }, provider, signal()),
    ).toMatchObject({ provider, status: "ok" });
    expect(getProviderAuth).toHaveBeenCalledExactlyOnceWith(piId);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "x-model-secret",
    );
  },
);

test.each([
  undefined,
  { source: "stored credential", auth: { apiKey: "api-key" } },
  { source: "ANTHROPIC_API_KEY", auth: { apiKey: "api-key" } },
  { source: "OAuth", auth: {} },
  { source: "OAuth", auth: { apiKey: "" } },
])(
  "does not send non-subscription credentials to quota endpoints: %j",
  async (resolved) => {
    const getProviderAuth = vi.fn<ResolveAuth>().mockResolvedValue(resolved);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      await resolveUsage({ getProviderAuth }, "claude", signal()),
    ).toMatchObject({
      provider: "claude",
      status: "unavailable",
      message: expect.stringContaining("/login anthropic"),
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);

test("sanitizes Pi auth errors instead of leaking refresh tokens", async () => {
  const getProviderAuth = vi
    .fn<ResolveAuth>()
    .mockRejectedValue(new Error("private refresh-token and HTTP body"));
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(await resolveUsage({ getProviderAuth }, "codex", signal())).toEqual({
    provider: "codex",
    status: "error",
    message: "Could not resolve Pi credentials; try /login openai-codex.",
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("resolves auth again for each invocation, leaving refresh ownership with Pi", async () => {
  const getProviderAuth = vi
    .fn<ResolveAuth>()
    .mockResolvedValueOnce({ source: "OAuth", auth: { apiKey: "old-token" } })
    .mockResolvedValueOnce({
      source: "OAuth",
      auth: { apiKey: "refreshed-token" },
    });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => Response.json({ five_hour: null }));
  vi.stubGlobal("fetch", fetch);
  await resolveUsage({ getProviderAuth }, "claude", signal());
  await resolveUsage({ getProviderAuth }, "claude", signal());
  expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
    Authorization: "Bearer refreshed-token",
  });
});

test("cancels while awaiting auth and never fetches with a late token", async () => {
  let finish!: (value: Awaited<ReturnType<ResolveAuth>>) => void;
  const pending = new Promise<Awaited<ReturnType<ResolveAuth>>>((resolve) => {
    finish = resolve;
  });
  const getProviderAuth = vi.fn<ResolveAuth>().mockReturnValue(pending);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const result = resolveUsage({ getProviderAuth }, "claude", controller.signal);
  controller.abort(new Error("private abort reason"));
  await expect(result).resolves.toMatchObject({
    status: "error",
    message: "Usage request cancelled or timed out.",
  });
  finish({ source: "OAuth", auth: { apiKey: "late-token" } });
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
});

test("prior cancellation never resolves credentials", async () => {
  const getProviderAuth = vi.fn<ResolveAuth>();
  await expect(
    resolveUsage({ getProviderAuth }, "claude", AbortSignal.abort()),
  ).resolves.toMatchObject({ status: "error" });
  expect(getProviderAuth).not.toHaveBeenCalled();
});

test("returns safe fetch failures without throwing away the other provider's result", async () => {
  const getProviderAuth = vi
    .fn<ResolveAuth>()
    .mockImplementation(async (provider) => ({
      source: "OAuth",
      auth: { apiKey: provider === "anthropic" ? "claude-token" : jwt },
    }));
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) =>
      String(url).includes("anthropic")
        ? new Response("secret-token", { status: 429 })
        : Response.json({
            rate_limit: { primary_window: { used_percent: 0 } },
          }),
    ),
  );
  const results = await Promise.all([
    resolveUsage({ getProviderAuth }, "claude", signal()),
    resolveUsage({ getProviderAuth }, "codex", signal()),
  ]);
  expect(results[0]).toMatchObject({
    status: "error",
    message: expect.stringContaining("HTTP 429"),
  });
  expect(results[1]).toMatchObject({
    status: "ok",
    usage: { windows: [{ usedPercent: 0 }] },
  });
});
