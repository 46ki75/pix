import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { resolveUsage } from "./auth.ts";

type ResolveAuth = ExtensionContext["modelRegistry"]["getProviderAuth"];
const signal = () => new AbortController().signal;
const jwt = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
const museCredential = {
  type: "oauth" as const,
  refresh: "dca:muse-device-token",
  access: "LLM|muse-inference-key",
  expires: Date.now() + 60_000,
};

function metaRegistry(
  getProviderAuth: ResolveAuth,
  source: "stored" | "runtime" = "stored",
) {
  return {
    getProviderAuth,
    getProviderAuthStatus: vi.fn().mockReturnValue({
      configured: true,
      source,
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

test("uses Pi's stored Meta identity token instead of its derived inference key", async () => {
  const getProviderAuth = vi.fn<ResolveAuth>().mockResolvedValue({
    source: "OAuth",
    auth: { apiKey: "LLM|muse-inference-key" },
  });
  const readCredential = vi.fn().mockReturnValue(museCredential);
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      is_subs_active: true,
      subs_usage: {
        window: { used_percent: 8, window_duration_mins: 300 },
        weekly: { used_percent: 9 },
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);

  await expect(
    resolveUsage(
      metaRegistry(getProviderAuth),
      "muse",
      signal(),
      readCredential,
    ),
  ).resolves.toMatchObject({
    provider: "muse",
    status: "ok",
    usage: { windows: [{ usedPercent: 8 }, { usedPercent: 9 }] },
  });
  expect(getProviderAuth).toHaveBeenCalledExactlyOnceWith("meta");
  expect(readCredential).toHaveBeenCalledTimes(3);
  expect(readCredential.mock.calls).toEqual([["meta"], ["meta"], ["meta"]]);
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    body: "{}",
    headers: expect.objectContaining({
      Authorization: "Bearer dca:muse-device-token",
      "x-api-version": "1.0.0",
    }),
  });
  expect(JSON.stringify(fetch.mock.calls)).not.toContain("LLM|");
});

test("fails closed when Pi resolves Meta from a different credential store", async () => {
  const getProviderAuth = vi.fn<ResolveAuth>().mockResolvedValue({
    source: "OAuth",
    auth: { apiKey: "LLM|different-store-key" },
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);

  await expect(
    resolveUsage(
      metaRegistry(getProviderAuth),
      "muse",
      signal(),
      () => museCredential,
    ),
  ).resolves.toEqual({
    provider: "muse",
    status: "error",
    message: "Pi's Meta OAuth credential source changed; try /login meta.",
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("does not mint again when Pi refreshes Meta during auth resolution", async () => {
  const refreshed = {
    ...museCredential,
    access: "LLM|refreshed-inference-key",
    expires: museCredential.expires + 60_000,
  };
  const getProviderAuth = vi.fn<ResolveAuth>().mockResolvedValue({
    source: "OAuth",
    auth: { apiKey: refreshed.access },
  });
  const readCredential = vi
    .fn()
    .mockReturnValueOnce(museCredential)
    .mockReturnValueOnce(refreshed);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);

  await expect(
    resolveUsage(
      metaRegistry(getProviderAuth),
      "muse",
      signal(),
      readCredential,
    ),
  ).resolves.toEqual({
    provider: "muse",
    status: "error",
    message: "Pi refreshed Meta OAuth credentials; retry /usage muse.",
  });
  expect(getProviderAuth).toHaveBeenCalledOnce();
  expect(readCredential).toHaveBeenCalledTimes(2);
  expect(fetch).not.toHaveBeenCalled();
});

test("discards Meta quota if the login changes while the request is pending", async () => {
  let stored = museCredential;
  const getProviderAuth = vi.fn<ResolveAuth>().mockResolvedValue({
    source: "OAuth",
    auth: { apiKey: museCredential.access },
  });
  const readCredential = vi.fn(() => stored);
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  let finish!: (response: Response) => void;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
        requestStarted();
      }),
  );
  vi.stubGlobal("fetch", fetch);

  const result = resolveUsage(
    metaRegistry(getProviderAuth),
    "muse",
    signal(),
    readCredential,
  );
  await started;
  stored = {
    ...museCredential,
    refresh: "dca:replacement-device-token",
    access: "LLM|replacement-inference-key",
  };
  finish(Response.json({ is_subs_active: true, subs_usage: null }));

  await expect(result).resolves.toEqual({
    provider: "muse",
    status: "error",
    message:
      "Pi's Meta OAuth credential changed during the usage check; retry /usage muse.",
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(readCredential).toHaveBeenCalledTimes(3);
});

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

test("does not inspect stored Meta credentials for a runtime API key", async () => {
  const getProviderAuth = vi.fn<ResolveAuth>();
  const readCredential = vi.fn();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);

  await expect(
    resolveUsage(
      metaRegistry(getProviderAuth, "runtime"),
      "muse",
      signal(),
      readCredential,
    ),
  ).resolves.toMatchObject({
    provider: "muse",
    status: "unavailable",
    message: expect.stringContaining("OAuth (not an API key)"),
  });
  expect(getProviderAuth).not.toHaveBeenCalled();
  expect(readCredential).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test.each([
  undefined,
  { type: "api_key", key: "dca:not-oauth" },
  {
    type: "oauth",
    access: museCredential.access,
    expires: museCredential.expires,
  },
  { ...museCredential, refresh: 42 },
  { ...museCredential, refresh: "dca:" },
  { ...museCredential, refresh: "LLM|inference-key" },
  { ...museCredential, refresh: "dca:bad token" },
  { ...museCredential, access: "" },
  { ...museCredential, expires: Number.NaN },
])("does not send unusable stored Meta credentials: %j", async (credential) => {
  const getProviderAuth = vi.fn<ResolveAuth>().mockResolvedValue({
    source: "OAuth",
    auth: { apiKey: "LLM|resolved-inference-key" },
  });
  const readCredential = vi.fn().mockReturnValue(credential);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);

  await expect(
    resolveUsage(
      metaRegistry(getProviderAuth),
      "muse",
      signal(),
      readCredential,
    ),
  ).resolves.toMatchObject({
    provider: "muse",
    status: "unavailable",
    message: expect.stringContaining("/login meta"),
  });
  expect(getProviderAuth).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test("sanitizes stored Meta credential read errors", async () => {
  const getProviderAuth = vi.fn<ResolveAuth>().mockResolvedValue({
    source: "OAuth",
    auth: { apiKey: "LLM|resolved-inference-key" },
  });
  const readCredential = vi.fn(() => {
    throw new Error("private file and token details");
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);

  await expect(
    resolveUsage(
      metaRegistry(getProviderAuth),
      "muse",
      signal(),
      readCredential,
    ),
  ).resolves.toEqual({
    provider: "muse",
    status: "error",
    message: "Could not read Pi's Meta OAuth credential; try /login meta.",
  });
  expect(fetch).not.toHaveBeenCalled();
});

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

test("retries one transient usage timeout without resolving credentials again", async () => {
  const getProviderAuth = vi.fn<ResolveAuth>().mockResolvedValue({
    source: "OAuth",
    auth: { apiKey: "access-token" },
  });
  const firstTimeout = new AbortController();
  vi.spyOn(AbortSignal, "timeout")
    .mockReturnValueOnce(firstTimeout.signal)
    .mockReturnValueOnce(new AbortController().signal);
  let started!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          started();
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        }),
    )
    .mockResolvedValueOnce(Response.json({ five_hour: { utilization: 25 } }));
  vi.stubGlobal("fetch", fetch);

  const result = resolveUsage({ getProviderAuth }, "claude", signal());
  await firstRequest;
  firstTimeout.abort();

  await expect(result).resolves.toMatchObject({
    status: "ok",
    usage: { windows: [{ usedPercent: 25 }] },
  });
  expect(getProviderAuth).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("does not retry a timed-out Meta key-mint request", async () => {
  const getProviderAuth = vi.fn<ResolveAuth>().mockResolvedValue({
    source: "OAuth",
    auth: { apiKey: "LLM|muse-inference-key" },
  });
  const timeout = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        started();
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetch);

  const result = resolveUsage(
    metaRegistry(getProviderAuth),
    "muse",
    signal(),
    () => museCredential,
  );
  await requestStarted;
  timeout.abort();
  await expect(result).resolves.toEqual({
    provider: "muse",
    status: "error",
    message: "Usage request timed out.",
  });
  expect(fetch).toHaveBeenCalledOnce();
});

test("does not retry an unclassified network failure", async () => {
  const getProviderAuth = vi.fn<ResolveAuth>().mockResolvedValue({
    source: "OAuth",
    auth: { apiKey: "access-token" },
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(new Error("private network details"));
  vi.stubGlobal("fetch", fetch);

  await expect(
    resolveUsage({ getProviderAuth }, "claude", signal()),
  ).resolves.toEqual({
    provider: "claude",
    status: "error",
    message: "Usage network request failed.",
  });
  expect(getProviderAuth).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
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
  const readCredential = vi.fn();
  await expect(
    resolveUsage(
      metaRegistry(getProviderAuth),
      "muse",
      AbortSignal.abort(),
      readCredential,
    ),
  ).resolves.toMatchObject({ status: "error" });
  expect(getProviderAuth).not.toHaveBeenCalled();
  expect(readCredential).not.toHaveBeenCalled();
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
