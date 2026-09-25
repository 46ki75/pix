import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortable } from "./http.ts";
import { fetchClaudeUsage, fetchCodexUsage } from "./providers.ts";
import { UsageError, type UsageProvider, type UsageResult } from "./types.ts";

const PROVIDER_IDS = { claude: "anthropic", codex: "openai-codex" } as const;

export async function resolveUsage(
  registry: Pick<ExtensionContext["modelRegistry"], "getProviderAuth">,
  provider: UsageProvider,
  signal: AbortSignal,
): Promise<UsageResult> {
  const providerId = PROVIDER_IDS[provider];
  try {
    signal.throwIfAborted();
    let resolved: Awaited<ReturnType<typeof registry.getProviderAuth>>;
    try {
      resolved = await abortable(registry.getProviderAuth(providerId), signal);
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
    const fetchUsage =
      provider === "claude" ? fetchClaudeUsage : fetchCodexUsage;
    const usage = await fetchUsage(resolved.auth.apiKey, { signal });
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
