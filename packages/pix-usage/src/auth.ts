import {
  type ExtensionContext,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import { abortable } from "./http.ts";
import {
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchMuseUsage,
  fetchOpenCodeUsage,
} from "./providers.ts";
import {
  UsageError,
  type UsageProvider,
  type UsageResult,
  type UsageSnapshot,
} from "./types.ts";

const PROVIDER_IDS = {
  claude: "anthropic",
  codex: "openai-codex",
  muse: "meta",
  opencode: "opencode-go",
} as const;
const FETCH_USAGE = {
  claude: fetchClaudeUsage,
  codex: fetchCodexUsage,
  muse: fetchMuseUsage,
  opencode: fetchOpenCodeUsage,
} as const;
const FETCH_ATTEMPTS = 2;
const OPENCODE_LOGIN_MESSAGE =
  "No Pi OpenCode Go API key; use /login opencode-go.";
const OPENCODE_PROVIDER_MESSAGE =
  "OpenCode Go usage requires Pi's built-in opencode-go provider with its first-party endpoint.";
const OPENCODE_MODEL_URLS = new Set([
  "https://opencode.ai/zen/go",
  "https://opencode.ai/zen/go/v1",
]);

export type StoredCredentialReader = typeof readStoredCredential;
type StoredOAuthCredential = Extract<
  NonNullable<ReturnType<StoredCredentialReader>>,
  { type: "oauth" }
>;
type UsageRegistry = Pick<
  ExtensionContext["modelRegistry"],
  "getProviderAuth"
> &
  Partial<
    Pick<
      ExtensionContext["modelRegistry"],
      "getProviderAuthStatus" | "getProvider" | "getRegisteredProviderIds"
    >
  >;

function isOpenCodeModelUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const normalized = `${url.origin}${url.pathname.replace(/\/$/u, "")}`;
    return (
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      OPENCODE_MODEL_URLS.has(normalized)
    );
  } catch {
    return false;
  }
}

function readStoredOpenCodeKey(
  registry: UsageRegistry,
  readCredential: StoredCredentialReader,
): string | undefined {
  try {
    const status = registry.getProviderAuthStatus?.("opencode-go");
    if (status?.configured !== true || status.source !== "stored")
      return undefined;
    const stored = readCredential("opencode-go");
    // Pi treats a leading "!" as a credential command. Read the literal value
    // directly so automatic quota refreshes never execute commands or resolve
    // configured model headers that are not used by this request.
    return stored?.type === "api_key" &&
      typeof stored.key === "string" &&
      stored.key.length > 0 &&
      !stored.key.startsWith("!")
      ? stored.key
      : undefined;
  } catch {
    return undefined;
  }
}

function usesFirstPartyOpenCodeRouting(registry: UsageRegistry): boolean {
  try {
    if (
      !registry.getProvider ||
      !registry.getRegisteredProviderIds ||
      registry.getRegisteredProviderIds().includes("opencode-go")
    )
      return false;
    const configured = registry.getProvider("opencode-go");
    if (!configured) return false;
    const urls = [
      ...(configured.baseUrl ? [configured.baseUrl] : []),
      ...configured.getModels().map((model) => model.baseUrl),
    ];
    return urls.length > 0 && urls.every(isOpenCodeModelUrl);
  } catch {
    return false;
  }
}

function museCredential(
  credential: ReturnType<StoredCredentialReader>,
): StoredOAuthCredential | undefined {
  if (
    credential?.type !== "oauth" ||
    typeof credential.refresh !== "string" ||
    !/^dca:\S+$/.test(credential.refresh) ||
    typeof credential.access !== "string" ||
    !credential.access ||
    typeof credential.expires !== "number" ||
    !Number.isFinite(credential.expires)
  )
    return undefined;
  return credential;
}

function sameCredential(
  left: StoredOAuthCredential,
  right: StoredOAuthCredential,
): boolean {
  return (
    left.access === right.access &&
    left.refresh === right.refresh &&
    left.expires === right.expires
  );
}

async function fetchUsageWithRetry(
  provider: UsageProvider,
  accessToken: string,
  signal: AbortSignal,
  beforeRetry?: () => void,
): Promise<UsageSnapshot> {
  const fetchUsage = FETCH_USAGE[provider];
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchUsage(accessToken, { signal });
    } catch (error) {
      signal.throwIfAborted();
      // A generic fetch rejection may be a blocked redirect or permanent TLS
      // failure. The Muse POST also mints a key, so it is not retried.
      if (
        provider === "muse" ||
        attempt >= FETCH_ATTEMPTS ||
        !(error instanceof UsageError) ||
        error.code !== "timeout"
      )
        throw error;
      beforeRetry?.();
      signal.throwIfAborted();
    }
  }
}

export async function resolveUsage(
  registry: UsageRegistry,
  provider: UsageProvider,
  signal: AbortSignal,
  readCredential: StoredCredentialReader = readStoredCredential,
): Promise<UsageResult> {
  const providerId = PROVIDER_IDS[provider];
  try {
    signal.throwIfAborted();
    let token: string;
    let beforeRetry: (() => void) | undefined;
    let museCredentialAtRequest: StoredOAuthCredential | undefined;
    let readCurrentMuseCredential:
      | (() => StoredOAuthCredential | undefined)
      | undefined;
    if (provider === "muse") {
      const status = registry.getProviderAuthStatus?.(providerId);
      if (!status?.configured || status.source !== "stored") {
        return {
          provider,
          status: "unavailable",
          message: `No Pi subscription login; use /login ${providerId} with OAuth (not an API key).`,
        };
      }
      const readMuseCredential = () => {
        try {
          return readCredential(providerId);
        } catch {
          throw new UsageError(
            "auth",
            "Could not read Pi's Meta OAuth credential; try /login meta.",
          );
        }
      };
      const credential = museCredential(readMuseCredential());
      signal.throwIfAborted();
      if (!credential) {
        return {
          provider,
          status: "unavailable",
          message:
            "Meta Muse usage requires Pi's device-code OAuth login; use /login meta.",
        };
      }
      let resolved: Awaited<ReturnType<typeof registry.getProviderAuth>>;
      try {
        resolved = await abortable(
          registry.getProviderAuth(providerId),
          signal,
        );
      } catch {
        signal.throwIfAborted();
        throw new UsageError(
          "auth",
          "Could not resolve Pi credentials; try /login meta.",
        );
      }
      signal.throwIfAborted();
      if (resolved?.source !== "OAuth" || !resolved.auth.apiKey) {
        return {
          provider,
          status: "unavailable",
          message: `No Pi subscription login; use /login ${providerId} with OAuth (not an API key).`,
        };
      }
      const current = museCredential(readMuseCredential());
      signal.throwIfAborted();
      if (!current) {
        return {
          provider,
          status: "unavailable",
          message:
            "Meta Muse usage requires Pi's device-code OAuth login; use /login meta.",
        };
      }
      // Fail closed if the registry and public file reader refer to different
      // stores, or if login changed while this request was being prepared.
      if (current.access !== resolved.auth.apiKey) {
        throw new UsageError(
          "auth",
          "Pi's Meta OAuth credential source changed; try /login meta.",
        );
      }
      // getProviderAuth() may itself call Meta's key-mint endpoint to refresh.
      // Never follow that side effect with a second mint in the same check.
      if (!sameCredential(current, credential)) {
        throw new UsageError(
          "auth",
          "Pi refreshed Meta OAuth credentials; retry /usage muse.",
        );
      }
      token = current.refresh;
      museCredentialAtRequest = current;
      readCurrentMuseCredential = () => museCredential(readMuseCredential());
    } else if (provider === "opencode") {
      if (!usesFirstPartyOpenCodeRouting(registry)) {
        return {
          provider,
          status: "unavailable",
          message: OPENCODE_PROVIDER_MESSAGE,
        };
      }
      const storedKey = readStoredOpenCodeKey(registry, readCredential);
      signal.throwIfAborted();
      if (!storedKey) {
        return {
          provider,
          status: "unavailable",
          message: OPENCODE_LOGIN_MESSAGE,
        };
      }
      if (!usesFirstPartyOpenCodeRouting(registry)) {
        return {
          provider,
          status: "unavailable",
          message: OPENCODE_PROVIDER_MESSAGE,
        };
      }
      if (readStoredOpenCodeKey(registry, readCredential) !== storedKey) {
        return {
          provider,
          status: "unavailable",
          message: OPENCODE_LOGIN_MESSAGE,
        };
      }
      token = storedKey;
      beforeRetry = () => {
        if (!usesFirstPartyOpenCodeRouting(registry)) {
          throw new UsageError("auth", OPENCODE_PROVIDER_MESSAGE);
        }
        if (readStoredOpenCodeKey(registry, readCredential) !== storedKey) {
          throw new UsageError("auth", OPENCODE_LOGIN_MESSAGE);
        }
      };
    } else {
      let resolved: Awaited<ReturnType<typeof registry.getProviderAuth>>;
      try {
        resolved = await abortable(
          registry.getProviderAuth(providerId),
          signal,
        );
      } catch {
        signal.throwIfAborted();
        // Provider refresh errors may contain response bodies or secret values.
        throw new UsageError(
          "auth",
          `Could not resolve Pi credentials; try /login ${providerId}.`,
        );
      }
      signal.throwIfAborted();
      if (resolved?.source !== "OAuth" || !resolved.auth.apiKey) {
        return {
          provider,
          status: "unavailable",
          message: `No Pi subscription login; use /login ${providerId} with OAuth (not an API key).`,
        };
      }
      token = resolved.auth.apiKey;
    }
    const usage = await fetchUsageWithRetry(
      provider,
      token,
      signal,
      beforeRetry,
    );
    if (museCredentialAtRequest && readCurrentMuseCredential) {
      const current = readCurrentMuseCredential();
      signal.throwIfAborted();
      if (!current || !sameCredential(current, museCredentialAtRequest)) {
        throw new UsageError(
          "auth",
          "Pi's Meta OAuth credential changed during the usage check; retry /usage muse.",
        );
      }
    }
    return { provider, status: "ok", usage };
  } catch (error) {
    return {
      provider,
      status: "error",
      message: signal.aborted
        ? "Usage request cancelled or timed out."
        : error instanceof UsageError
          ? error.message
          : "Usage request failed.",
    };
  }
}
