import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveUsage } from "./auth.ts";
import { fetchCopilotUsage } from "./providers.ts";
import { UsageError, type UsageSnapshot } from "./types.ts";

// Mock the public reader itself as well as the injected reader: an accidental
// fallback must fail the test rather than inspect personal Pi credentials.
const { publicReader } = vi.hoisted(() => ({ publicReader: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  readStoredCredential: publicReader,
}));
vi.mock("./providers.ts", () => ({
  fetchClaudeUsage: vi.fn(),
  fetchCodexUsage: vi.fn(),
  fetchMuseUsage: vi.fn(),
  fetchOpenCodeUsage: vi.fn(),
  fetchCopilotUsage: vi.fn(),
}));

type AuthStatus = ReturnType<
  ExtensionContext["modelRegistry"]["getProviderAuthStatus"]
>;
const PROVIDER_ID = "github-copilot";
const MODEL_URL = "https://api.individual.githubcopilot.com";
const LOGIN_MESSAGE =
  "No Pi GitHub Copilot OAuth login; use /login github-copilot (not an API key).";
const ROUTING_MESSAGE =
  "GitHub Copilot usage requires Pi's built-in github-copilot provider with first-party endpoints.";
const ISSUER_MESSAGE =
  "GitHub Copilot usage supports only Pi OAuth logins issued by github.com; GitHub Enterprise and malformed issuer metadata are not supported.";
const CHANGED_MESSAGE =
  "Pi's GitHub Copilot login or routing changed; retry /usage copilot.";
const credential = {
  type: "oauth" as const,
  refresh: "gho_test_github_oauth_token",
  access: "tid=test;exp=1;proxy-ep=proxy.individual.githubcopilot.com;",
  expires: 1, // The inference token may expire without expiring the GitHub token.
};
const snapshot: UsageSnapshot = {
  provider: "copilot",
  fetchedAt: "2026-10-01T00:00:00Z",
  windows: [],
};
const fetchUsage = vi.mocked(fetchCopilotUsage);
const signal = () => new AbortController().signal;

function setup() {
  const routing = {
    id: PROVIDER_ID,
    baseUrl: MODEL_URL,
    models: [{ baseUrl: MODEL_URL, headers: { "x-model-secret": "!command" } }],
    getModels() {
      return this.models;
    },
    headers: { "x-provider-secret": "!another-command" },
  };
  const registry = {
    getProviderAuth:
      vi.fn<ExtensionContext["modelRegistry"]["getProviderAuth"]>(),
    getProviderAuthStatus: vi.fn<() => AuthStatus>().mockReturnValue({
      configured: true,
      source: "stored",
    }),
    getRegisteredProviderIds: vi.fn().mockReturnValue([]),
    getProvider: vi.fn().mockReturnValue(routing),
  };
  const stored = { ...credential };
  const readCredential = vi.fn().mockReturnValue(stored);
  return { registry, routing, readCredential, stored };
}

beforeEach(() => {
  vi.resetAllMocks();
  publicReader.mockImplementation(() => {
    throw new Error("Unexpected personal credential read");
  });
  fetchUsage.mockResolvedValue(snapshot);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each([undefined, "github.com"])(
  "uses the stored GitHub OAuth token with issuer %s, never the inference token or model headers",
  async (enterpriseUrl) => {
    const { registry, readCredential } = setup();
    readCredential.mockReturnValue({ ...credential, enterpriseUrl });
    await expect(
      resolveUsage(registry, "copilot", signal(), readCredential),
    ).resolves.toEqual({ provider: "copilot", status: "ok", usage: snapshot });
    expect(fetchUsage).toHaveBeenCalledExactlyOnceWith(credential.refresh, {
      signal: expect.any(AbortSignal),
    });
    expect(registry.getProviderAuth).not.toHaveBeenCalled();
    expect(publicReader).not.toHaveBeenCalled();
    expect(readCredential.mock.calls).toEqual([
      [PROVIDER_ID],
      [PROVIDER_ID],
      [PROVIDER_ID],
    ]);
    expect(JSON.stringify(fetchUsage.mock.calls)).not.toContain(
      credential.access,
    );
    expect(registry.getProviderAuthStatus).toHaveBeenCalledWith(PROVIDER_ID);
    expect(registry.getProvider).toHaveBeenCalledWith(PROVIDER_ID);
  },
);

test("uses Pi's public stored-credential reader by default without model auth resolution", async () => {
  const { registry } = setup();
  publicReader.mockReturnValue(credential);
  await expect(
    resolveUsage(registry, "copilot", signal()),
  ).resolves.toMatchObject({
    status: "ok",
  });
  expect(publicReader.mock.calls).toEqual([
    [PROVIDER_ID],
    [PROVIDER_ID],
    [PROVIDER_ID],
  ]);
  expect(registry.getProviderAuth).not.toHaveBeenCalled();
});

test.each([
  { configured: false },
  { configured: false, source: "stored" },
  { configured: true, source: "runtime" },
  { configured: true, source: "environment", label: "COPILOT_GITHUB_TOKEN" },
  { configured: true, source: "models_json_key" },
  { configured: true, source: "models_json_command" },
  { configured: true, source: "fallback" },
  { configured: true },
] as const)(
  "rejects a non-stored authentication source: %j",
  async (status) => {
    const { registry, readCredential } = setup();
    registry.getProviderAuthStatus.mockReturnValue(status);
    await expect(
      resolveUsage(registry, "copilot", signal(), readCredential),
    ).resolves.toEqual({
      provider: "copilot",
      status: "unavailable",
      message: LOGIN_MESSAGE,
    });
    expect(readCredential).not.toHaveBeenCalled();
    expect(registry.getProviderAuth).not.toHaveBeenCalled();
    expect(fetchUsage).not.toHaveBeenCalled();
  },
);

test.each([
  undefined,
  null,
  { type: "api_key", key: "gho_saved_api_key" },
  { type: "api_key", key: "!get-copilot-token" },
  { ...credential, type: "unknown" },
  { ...credential, refresh: undefined },
  { ...credential, refresh: 42 },
  { ...credential, refresh: "" },
  { ...credential, refresh: "!get-copilot-token" },
  { ...credential, refresh: " gho_token" },
  { ...credential, refresh: "gho_token\r\nX-Secret: value" },
  { ...credential, refresh: credential.access },
  { ...credential, access: undefined },
  { ...credential, access: "" },
  { ...credential, access: 42 },
  { ...credential, expires: undefined },
  { ...credential, expires: "1" },
  { ...credential, expires: Number.NaN },
  { ...credential, expires: Number.POSITIVE_INFINITY },
])(
  "rejects missing, command, or malformed stored OAuth credentials: %j",
  async (stored) => {
    const { registry, readCredential } = setup();
    readCredential.mockReturnValue(stored);
    await expect(
      resolveUsage(registry, "copilot", signal(), readCredential),
    ).resolves.toEqual({
      provider: "copilot",
      status: "unavailable",
      message: LOGIN_MESSAGE,
    });
    expect(readCredential).toHaveBeenCalledExactlyOnceWith(PROVIDER_ID);
    expect(registry.getProviderAuth).not.toHaveBeenCalled();
    expect(fetchUsage).not.toHaveBeenCalled();
  },
);

test.each([
  "company.ghe.com",
  "ghe.com",
  "copilot-api.company.ghe.com",
  "github.example",
  "github.com.example",
  "api.github.com",
  "https://github.com",
  "http://github.com",
  "https://github.com/",
  "github.com:443",
  "github.com/path",
  "github.com?query=1",
  "github.com#fragment",
  "github.com@company.ghe.com",
  "github.com.",
  "GITHUB.COM",
  " github.com",
  "github.com ",
  "",
  " ",
  null,
  false,
  42,
  {},
  [],
])(
  "rejects unsupported or malformed issuer metadata before transmission: %j",
  async (enterpriseUrl) => {
    const { registry, readCredential } = setup();
    readCredential.mockReturnValue({ ...credential, enterpriseUrl });
    await expect(
      resolveUsage(registry, "copilot", signal(), readCredential),
    ).resolves.toEqual({
      provider: "copilot",
      status: "unavailable",
      message: ISSUER_MESSAGE,
    });
    expect(registry.getProviderAuth).not.toHaveBeenCalled();
    expect(fetchUsage).not.toHaveBeenCalled();
  },
);

test.each(
  [
    "https://api.githubcopilot.com",
    MODEL_URL,
    "https://api.business.githubcopilot.com",
    "https://api.enterprise.githubcopilot.com",
  ].flatMap((url) => [url, `${url}/`]),
)("accepts the exact first-party model root %s", async (url) => {
  const { registry, routing, readCredential } = setup();
  routing.baseUrl = url;
  routing.models[0]!.baseUrl = url;
  await expect(
    resolveUsage(registry, "copilot", signal(), readCredential),
  ).resolves.toMatchObject({ status: "ok" });
  expect(fetchUsage).toHaveBeenCalledOnce();
});

test.each([
  "https://proxy.example",
  "http://api.individual.githubcopilot.com",
  "https://api.individual.githubcopilot.com.example",
  "https://sub.api.individual.githubcopilot.com",
  "https://unknown.githubcopilot.com",
  "https://api.github.com",
  "https://copilot-api.github.com",
  "https://copilot-api.company.ghe.com",
  "https://api.individual.githubcopilot.com:8443",
  "https://user@api.individual.githubcopilot.com",
  "https://user:password@api.individual.githubcopilot.com",
  `${MODEL_URL}/v1`,
  `${MODEL_URL}/path`,
  `${MODEL_URL}/path/..`,
  `${MODEL_URL}//`,
  `${MODEL_URL}?key=secret`,
  `${MODEL_URL}#fragment`,
  ` ${MODEL_URL}`,
  "https://api.individual.githubcopilot.com.",
  "not-a-url",
  "",
])("rejects custom provider and model routes: %s", async (url) => {
  for (const location of ["provider", "model"] as const) {
    const { registry, routing, readCredential } = setup();
    if (location === "provider") routing.baseUrl = url;
    else
      routing.models.push({
        baseUrl: url,
        headers: { "x-model-secret": "!command" },
      });
    await expect(
      resolveUsage(registry, "copilot", signal(), readCredential),
    ).resolves.toEqual({
      provider: "copilot",
      status: "unavailable",
      message: ROUTING_MESSAGE,
    });
    expect(readCredential).not.toHaveBeenCalled();
    expect(registry.getProviderAuth).not.toHaveBeenCalled();
    expect(fetchUsage).not.toHaveBeenCalled();
  }
});

test("rejects extension overrides even when their URLs are first-party", async () => {
  const { registry, readCredential } = setup();
  registry.getRegisteredProviderIds.mockReturnValue([PROVIDER_ID]);
  await expect(
    resolveUsage(registry, "copilot", signal(), readCredential),
  ).resolves.toEqual({
    provider: "copilot",
    status: "unavailable",
    message: ROUTING_MESSAGE,
  });
  expect(readCredential).not.toHaveBeenCalled();
  expect(fetchUsage).not.toHaveBeenCalled();
});

test.each([
  "getProviderAuthStatus",
  "getProvider",
  "getRegisteredProviderIds",
] as const)("fails closed without the public %s API", async (method) => {
  const { registry, readCredential } = setup();
  const partialRegistry = { ...registry, [method]: undefined };
  await expect(
    resolveUsage(partialRegistry, "copilot", signal(), readCredential),
  ).resolves.toMatchObject({ status: "unavailable" });
  expect(readCredential).not.toHaveBeenCalled();
  expect(fetchUsage).not.toHaveBeenCalled();
});

test.each([
  undefined,
  { id: "custom-provider", baseUrl: MODEL_URL, getModels: () => [] },
  { id: PROVIDER_ID, baseUrl: undefined, getModels: () => [] },
  {
    id: PROVIDER_ID,
    baseUrl: MODEL_URL,
    getModels: () => [{ baseUrl: undefined }],
  },
  { id: PROVIDER_ID, baseUrl: MODEL_URL, getModels: () => [{ baseUrl: null }] },
])(
  "fails closed on absent or malformed provider metadata: %j",
  async (provider) => {
    const { registry, readCredential } = setup();
    registry.getProvider.mockReturnValue(provider);
    await expect(
      resolveUsage(registry, "copilot", signal(), readCredential),
    ).resolves.toMatchObject({
      status: "unavailable",
      message: ROUTING_MESSAGE,
    });
    expect(readCredential).not.toHaveBeenCalled();
    expect(fetchUsage).not.toHaveBeenCalled();
  },
);

test("accepts known model routing without a provider base URL", async () => {
  const { registry, routing, readCredential } = setup();
  registry.getProvider.mockReturnValue({ ...routing, baseUrl: undefined });
  await expect(
    resolveUsage(registry, "copilot", signal(), readCredential),
  ).resolves.toMatchObject({ status: "ok" });
});

type Fixture = ReturnType<typeof setup>;
const changes: [string, (fixture: Fixture) => void][] = [
  [
    "GitHub token",
    ({ stored }) => {
      stored.refresh = "gho_replacement";
    },
  ],
  [
    "inference token",
    ({ stored }) => {
      stored.access = "replacement-inference-token";
    },
  ],
  [
    "inference expiry",
    ({ stored }) => {
      stored.expires += 1;
    },
  ],
  [
    "credential type",
    ({ readCredential }) => {
      readCredential.mockReturnValue({ type: "api_key", key: "gho_api_key" });
    },
  ],
  [
    "logout",
    ({ readCredential }) => {
      readCredential.mockReturnValue(undefined);
    },
  ],
  [
    "source",
    ({ registry }) => {
      registry.getProviderAuthStatus.mockReturnValue({
        configured: true,
        source: "runtime",
      });
    },
  ],
  [
    "enterprise issuer",
    ({ readCredential }) => {
      readCredential.mockReturnValue({
        ...credential,
        enterpriseUrl: "company.ghe.com",
      });
    },
  ],
  [
    "explicit issuer",
    ({ readCredential }) => {
      readCredential.mockReturnValue({
        ...credential,
        enterpriseUrl: "github.com",
      });
    },
  ],
  [
    "provider override",
    ({ registry }) => {
      registry.getRegisteredProviderIds.mockReturnValue([PROVIDER_ID]);
    },
  ],
  [
    "provider route",
    ({ routing }) => {
      routing.baseUrl = "https://proxy.example";
    },
  ],
  [
    "model route",
    ({ routing }) => {
      routing.models[0]!.baseUrl = "https://proxy.example";
    },
  ],
  [
    "allowed route replacement",
    ({ routing }) => {
      routing.baseUrl = "https://api.business.githubcopilot.com";
    },
  ],
];

test.each(changes)(
  "rejects a %s change before the initial request",
  async (_name, change) => {
    const fixture = setup();
    fixture.readCredential.mockImplementationOnce(() => {
      const current = { ...fixture.stored };
      change(fixture);
      return current;
    });
    await expect(
      resolveUsage(
        fixture.registry,
        "copilot",
        signal(),
        fixture.readCredential,
      ),
    ).resolves.toEqual({
      provider: "copilot",
      status: "error",
      message: CHANGED_MESSAGE,
    });
    expect(fixture.registry.getProviderAuth).not.toHaveBeenCalled();
    expect(fetchUsage).not.toHaveBeenCalled();
  },
);

test.each(changes)(
  "discards a completed request after a %s change",
  async (_name, change) => {
    const fixture = setup();
    let finish!: (value: UsageSnapshot) => void;
    fetchUsage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = resolveUsage(
      fixture.registry,
      "copilot",
      signal(),
      fixture.readCredential,
    );
    expect(fetchUsage).toHaveBeenCalledOnce();
    change(fixture);
    finish(snapshot);
    await expect(result).resolves.toEqual({
      provider: "copilot",
      status: "error",
      message: CHANGED_MESSAGE,
    });
    expect(fixture.registry.getProviderAuth).not.toHaveBeenCalled();
    expect(fetchUsage).toHaveBeenCalledOnce();
  },
);

test.each(changes)(
  "refuses a timeout retry after a %s change",
  async (_name, change) => {
    const fixture = setup();
    fetchUsage.mockImplementationOnce(async () => {
      change(fixture);
      throw new UsageError("timeout", "Usage request timed out.");
    });
    await expect(
      resolveUsage(
        fixture.registry,
        "copilot",
        signal(),
        fixture.readCredential,
      ),
    ).resolves.toEqual({
      provider: "copilot",
      status: "error",
      message: CHANGED_MESSAGE,
    });
    expect(fixture.registry.getProviderAuth).not.toHaveBeenCalled();
    expect(fetchUsage).toHaveBeenCalledOnce();
  },
);

test("revalidates before a timeout retry and after completion, reusing only the unchanged GitHub token", async () => {
  const { registry, readCredential } = setup();
  fetchUsage.mockRejectedValueOnce(
    new UsageError("timeout", "Usage request timed out."),
  );
  await expect(
    resolveUsage(registry, "copilot", signal(), readCredential),
  ).resolves.toEqual({
    provider: "copilot",
    status: "ok",
    usage: snapshot,
  });
  expect(fetchUsage).toHaveBeenCalledTimes(2);
  expect(fetchUsage.mock.calls.map(([token]) => token)).toEqual([
    credential.refresh,
    credential.refresh,
  ]);
  expect(readCredential.mock.calls).toEqual(
    Array.from({ length: 4 }, () => [PROVIDER_ID]),
  );
  expect(registry.getProvider).toHaveBeenCalledTimes(4);
  expect(registry.getProviderAuthStatus).toHaveBeenCalledTimes(4);
  expect(registry.getProviderAuth).not.toHaveBeenCalled();
});

test("retries a timeout only once", async () => {
  const { registry, readCredential } = setup();
  fetchUsage.mockRejectedValue(
    new UsageError("timeout", "Usage request timed out."),
  );
  await expect(
    resolveUsage(registry, "copilot", signal(), readCredential),
  ).resolves.toEqual({
    provider: "copilot",
    status: "error",
    message: "Usage request timed out.",
  });
  expect(fetchUsage).toHaveBeenCalledTimes(2);
  expect(readCredential).toHaveBeenCalledTimes(4);
});

test.each(["auth", "http", "rate-limit", "network", "response"] as const)(
  "does not retry a %s failure",
  async (code) => {
    const { registry, readCredential } = setup();
    fetchUsage.mockRejectedValue(new UsageError(code, "Safe fetcher error."));
    await expect(
      resolveUsage(registry, "copilot", signal(), readCredential),
    ).resolves.toMatchObject({
      status: "error",
      message: "Safe fetcher error.",
    });
    expect(fetchUsage).toHaveBeenCalledOnce();
    expect(readCredential).toHaveBeenCalledTimes(3);
  },
);

test("rechecks login even after a failed request", async () => {
  const fixture = setup();
  fetchUsage.mockImplementationOnce(async () => {
    fixture.stored.refresh = "gho_replacement";
    throw new UsageError("auth", "Usage access denied (HTTP 401).");
  });
  await expect(
    resolveUsage(fixture.registry, "copilot", signal(), fixture.readCredential),
  ).resolves.toEqual({
    provider: "copilot",
    status: "error",
    message: CHANGED_MESSAGE,
  });
  expect(fetchUsage).toHaveBeenCalledOnce();
});

test("sanitizes unexpected fetch errors", async () => {
  const { registry, readCredential } = setup();
  fetchUsage.mockRejectedValue(
    new Error("secret-token and private network details"),
  );
  await expect(
    resolveUsage(registry, "copilot", signal(), readCredential),
  ).resolves.toEqual({
    provider: "copilot",
    status: "error",
    message: "Usage request failed.",
  });
  expect(fetchUsage).toHaveBeenCalledOnce();
});

test.each([
  "initial read",
  "request recheck",
  "completion recheck",
  "retry recheck",
] as const)("sanitizes credential-reader errors during %s", async (stage) => {
  const { registry, readCredential } = setup();
  const error = new UsageError("auth", "secret-token and private file details");
  const fail = () => {
    throw error;
  };
  if (stage === "initial read") readCredential.mockImplementationOnce(fail);
  else if (stage === "request recheck")
    readCredential.mockReturnValueOnce(credential).mockImplementationOnce(fail);
  else {
    fetchUsage.mockImplementationOnce(async () => {
      readCredential.mockImplementation(fail);
      if (stage === "retry recheck")
        throw new UsageError("timeout", "Usage request timed out.");
      return snapshot;
    });
  }
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    resolveUsage(registry, "copilot", signal(), readCredential),
  ).resolves.toEqual({
    provider: "copilot",
    status: "error",
    message:
      "Could not read Pi's GitHub Copilot OAuth credential; try /login github-copilot.",
  });
  expect(log).not.toHaveBeenCalled();
  expect(registry.getProviderAuth).not.toHaveBeenCalled();
  expect(fetchUsage.mock.calls.length).toBeLessThanOrEqual(1);
});

test("sanitizes auth-status errors without reading a credential", async () => {
  const { registry, readCredential } = setup();
  registry.getProviderAuthStatus.mockImplementation(() => {
    throw new Error("secret token");
  });
  await expect(
    resolveUsage(registry, "copilot", signal(), readCredential),
  ).resolves.toEqual({
    provider: "copilot",
    status: "error",
    message:
      "Could not check Pi's GitHub Copilot authentication; try /login github-copilot.",
  });
  expect(readCredential).not.toHaveBeenCalled();
  expect(fetchUsage).not.toHaveBeenCalled();
});

test.each(["getRegisteredProviderIds", "getProvider"] as const)(
  "sanitizes routing failures from %s",
  async (method) => {
    const { registry, readCredential } = setup();
    registry[method].mockImplementation(() => {
      throw new Error("secret token");
    });
    await expect(
      resolveUsage(registry, "copilot", signal(), readCredential),
    ).resolves.toEqual({
      provider: "copilot",
      status: "unavailable",
      message: ROUTING_MESSAGE,
    });
    expect(readCredential).not.toHaveBeenCalled();
    expect(fetchUsage).not.toHaveBeenCalled();
  },
);

test("rereads each invocation rather than caching a completed login", async () => {
  const fixture = setup();
  await expect(
    resolveUsage(fixture.registry, "copilot", signal(), fixture.readCredential),
  ).resolves.toMatchObject({ status: "ok" });
  fixture.stored.refresh = "gho_new_login";
  await expect(
    resolveUsage(fixture.registry, "copilot", signal(), fixture.readCredential),
  ).resolves.toMatchObject({ status: "ok" });
  expect(fetchUsage.mock.calls.map(([token]) => token)).toEqual([
    credential.refresh,
    "gho_new_login",
  ]);
  expect(fixture.readCredential).toHaveBeenCalledTimes(6);
});

test("prior cancellation does not inspect routing or credentials", async () => {
  const { registry, readCredential } = setup();
  await expect(
    resolveUsage(
      registry,
      "copilot",
      AbortSignal.abort(new Error("private reason")),
      readCredential,
    ),
  ).resolves.toEqual({
    provider: "copilot",
    status: "error",
    message: "Usage request cancelled or timed out.",
  });
  expect(registry.getProvider).not.toHaveBeenCalled();
  expect(registry.getProviderAuthStatus).not.toHaveBeenCalled();
  expect(registry.getProviderAuth).not.toHaveBeenCalled();
  expect(readCredential).not.toHaveBeenCalled();
  expect(fetchUsage).not.toHaveBeenCalled();
});

test("cancellation during credential checks prevents transmission", async () => {
  const { registry, readCredential } = setup();
  const controller = new AbortController();
  readCredential.mockImplementationOnce(() => {
    controller.abort(new Error("private reason"));
    return credential;
  });
  await expect(
    resolveUsage(registry, "copilot", controller.signal, readCredential),
  ).resolves.toMatchObject({
    status: "error",
    message: "Usage request cancelled or timed out.",
  });
  expect(readCredential).toHaveBeenCalledOnce();
  expect(fetchUsage).not.toHaveBeenCalled();
});

test.each([
  ["initial status", 1],
  ["request recheck", 2],
  ["retry recheck", 3],
  ["completion recheck", 3],
] as const)(
  "cancellation during %s prevents subsequent credential reads",
  async (stage, abortAt) => {
    const { registry, readCredential } = setup();
    const controller = new AbortController();
    let checks = 0;
    registry.getProviderAuthStatus.mockImplementation(() => {
      checks += 1;
      if (checks === abortAt) controller.abort(new Error("private reason"));
      return { configured: true, source: "stored" };
    });
    if (stage === "retry recheck")
      fetchUsage.mockRejectedValueOnce(
        new UsageError("timeout", "Usage request timed out."),
      );
    await expect(
      resolveUsage(registry, "copilot", controller.signal, readCredential),
    ).resolves.toMatchObject({
      status: "error",
      message: "Usage request cancelled or timed out.",
    });
    expect(readCredential).toHaveBeenCalledTimes(abortAt - 1);
    expect(fetchUsage).toHaveBeenCalledTimes(abortAt === 3 ? 1 : 0);
  },
);

test("cancels a pending quota request without retrying or rereading credentials", async () => {
  const { registry, readCredential } = setup();
  const controller = new AbortController();
  fetchUsage.mockImplementationOnce(
    (_token, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        );
      }),
  );
  const result = resolveUsage(
    registry,
    "copilot",
    controller.signal,
    readCredential,
  );
  controller.abort(new Error("private reason"));
  await expect(result).resolves.toMatchObject({
    status: "error",
    message: "Usage request cancelled or timed out.",
  });
  expect(fetchUsage).toHaveBeenCalledOnce();
  expect(readCredential).toHaveBeenCalledTimes(2);
});

test("cancellation prevents retry and completion credential reads", async () => {
  const { registry, readCredential } = setup();
  const controller = new AbortController();
  fetchUsage.mockImplementationOnce(async (_token, options) => {
    expect(options?.signal).toBe(controller.signal);
    controller.abort(new Error("private reason"));
    throw new UsageError("timeout", "Usage request timed out.");
  });
  await expect(
    resolveUsage(registry, "copilot", controller.signal, readCredential),
  ).resolves.toMatchObject({
    status: "error",
    message: "Usage request cancelled or timed out.",
  });
  expect(fetchUsage).toHaveBeenCalledOnce();
  expect(readCredential).toHaveBeenCalledTimes(2);
});

test("discards a late successful result after cancellation without rereading credentials", async () => {
  const { registry, readCredential } = setup();
  const controller = new AbortController();
  let finish!: (value: UsageSnapshot) => void;
  fetchUsage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const result = resolveUsage(
    registry,
    "copilot",
    controller.signal,
    readCredential,
  );
  controller.abort(new Error("private reason"));
  finish(snapshot);
  await expect(result).resolves.toMatchObject({
    status: "error",
    message: "Usage request cancelled or timed out.",
  });
  expect(readCredential).toHaveBeenCalledTimes(2);
  expect(fetchUsage).toHaveBeenCalledOnce();
});
