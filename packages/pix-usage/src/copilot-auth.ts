import type {
  ExtensionContext,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import { UsageError } from "./types.ts";

type CopilotRegistry = Partial<
  Pick<
    ExtensionContext["modelRegistry"],
    "getProviderAuthStatus" | "getProvider" | "getRegisteredProviderIds"
  >
>;
type CredentialReader = typeof readStoredCredential;
interface CopilotCredential {
  githubToken: string;
  access: string;
  expires: number;
  issuer: unknown;
}
type UnavailableAuth = { status: "unavailable"; message: string };
type CredentialCheck =
  | UnavailableAuth
  | { status: "ready"; credential: CopilotCredential };

const PROVIDER_ID = "github-copilot";
const LOGIN_MESSAGE =
  "No Pi GitHub Copilot OAuth login; use /login github-copilot (not an API key).";
const ROUTING_MESSAGE =
  "GitHub Copilot usage requires Pi's built-in github-copilot provider with first-party endpoints.";
const ISSUER_MESSAGE =
  "GitHub Copilot usage supports only Pi OAuth logins issued by github.com; GitHub Enterprise and malformed issuer metadata are not supported.";
const CHANGED_MESSAGE =
  "Pi's GitHub Copilot login or routing changed; retry /usage copilot.";

// Pi's built-in provider uses the Individual root. GitHub documents the plan
// routing domains at https://docs.github.com/en/copilot/reference/copilot-allowlist-reference.
// Do not accept arbitrary subdomains, paths, or GHE/data-residency endpoints.
const MODEL_URLS = new Set([
  "https://api.githubcopilot.com",
  "https://api.individual.githubcopilot.com",
  "https://api.business.githubcopilot.com",
  "https://api.enterprise.githubcopilot.com",
]);

function routingSnapshot(registry: CopilotRegistry): string | undefined {
  try {
    if (
      !registry.getProvider ||
      !registry.getRegisteredProviderIds ||
      registry.getRegisteredProviderIds().includes(PROVIDER_ID)
    )
      return undefined;
    const provider = registry.getProvider(PROVIDER_ID);
    if (!provider || provider.id !== PROVIDER_ID) return undefined;
    const urls = [
      ...(provider.baseUrl === undefined ? [] : [provider.baseUrl]),
      ...provider.getModels().map((model) => model.baseUrl),
    ];
    if (urls.length === 0) return undefined;
    const normalized = urls.map((value) =>
      typeof value === "string" ? value.replace(/\/$/u, "") : "",
    );
    if (!normalized.every((url) => MODEL_URLS.has(url))) return undefined;
    // Copy scalar state instead of retaining mutable provider/model references.
    return JSON.stringify([...new Set(normalized)].sort());
  } catch {
    return undefined;
  }
}

function checkCredential(
  registry: CopilotRegistry,
  readCredential: CredentialReader,
  signal: AbortSignal,
): CredentialCheck {
  let status: ReturnType<NonNullable<CopilotRegistry["getProviderAuthStatus"]>>;
  try {
    status = registry.getProviderAuthStatus?.(PROVIDER_ID) ?? {
      configured: false,
    };
  } catch {
    throw new UsageError(
      "auth",
      "Could not check Pi's GitHub Copilot authentication; try /login github-copilot.",
    );
  }
  signal.throwIfAborted();
  if (status.configured !== true || status.source !== "stored")
    return { status: "unavailable", message: LOGIN_MESSAGE };

  let stored: ReturnType<CredentialReader>;
  try {
    stored = readCredential(PROVIDER_ID);
  } catch {
    throw new UsageError(
      "auth",
      "Could not read Pi's GitHub Copilot OAuth credential; try /login github-copilot.",
    );
  }
  signal.throwIfAborted();
  if (
    stored?.type !== "oauth" ||
    typeof stored.refresh !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(stored.refresh) ||
    typeof stored.access !== "string" ||
    stored.access.length === 0 ||
    typeof stored.expires !== "number" ||
    !Number.isFinite(stored.expires)
  )
    return { status: "unavailable", message: LOGIN_MESSAGE };

  // Pi 0.87.1 and 1.1.0 persist enterpriseUrl as the normalized issuer hostname,
  // omitting it for the default github.com login. Malformed metadata must never
  // silently fall back to github.com as Pi's inference auth resolver can do.
  if (
    stored.enterpriseUrl !== undefined &&
    stored.enterpriseUrl !== "github.com"
  )
    return { status: "unavailable", message: ISSUER_MESSAGE };

  // Despite the field names, refresh is the GitHub OAuth token; access is the
  // derived Copilot inference token. Its expiry is irrelevant to quota access.
  return {
    status: "ready",
    credential: {
      githubToken: stored.refresh,
      access: stored.access,
      expires: stored.expires,
      issuer: stored.enterpriseUrl,
    },
  };
}

function sameCredential(
  left: CopilotCredential,
  right: CopilotCredential,
): boolean {
  return (
    left.githubToken === right.githubToken &&
    left.access === right.access &&
    left.expires === right.expires &&
    left.issuer === right.issuer
  );
}

export function prepareCopilotUsageAuth(
  registry: CopilotRegistry,
  readCredential: CredentialReader,
  signal: AbortSignal,
):
  | UnavailableAuth
  | { status: "ready"; githubToken: string; revalidate: () => void } {
  signal.throwIfAborted();
  const routing = routingSnapshot(registry);
  signal.throwIfAborted();
  if (!routing) return { status: "unavailable", message: ROUTING_MESSAGE };
  const initial = checkCredential(registry, readCredential, signal);
  signal.throwIfAborted();
  if (initial.status === "unavailable") return initial;

  const revalidate = () => {
    signal.throwIfAborted();
    const currentRouting = routingSnapshot(registry);
    signal.throwIfAborted();
    if (currentRouting !== routing)
      throw new UsageError("auth", CHANGED_MESSAGE);
    const current = checkCredential(registry, readCredential, signal);
    signal.throwIfAborted();
    if (
      current.status !== "ready" ||
      !sameCredential(initial.credential, current.credential)
    )
      throw new UsageError("auth", CHANGED_MESSAGE);
  };

  // Public status and file reads cannot prove a custom SDK store's identity.
  // Support only Pi's standard CLI store; never resolve model auth to correlate
  // tokens, since that can execute commands or mint/refresh inference tokens.
  revalidate();
  return {
    status: "ready",
    githubToken: initial.credential.githubToken,
    revalidate,
  };
}
