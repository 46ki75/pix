import {
  MAX_QUERY_LENGTH,
  MAX_RESULTS,
  type Provider,
  type ProviderId,
  SearchError,
  type SearchResponse,
  type Selection,
} from "./types.ts";

export function createSearch(
  providers: Provider[],
  options: { now?: () => number; random?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const cooldowns = new Map<ProviderId, number>();
  const preferences = new Map<string, { provider?: ProviderId }>();

  return {
    clearSessions() {
      preferences.clear();
    },
    async search(
      query: string,
      options: {
        selection: Selection;
        sessionId: string;
        signal?: AbortSignal;
      },
    ): Promise<SearchResponse> {
      const text = query.trim();
      if (!text || text.length > MAX_QUERY_LENGTH) {
        throw new SearchError(
          `Search query must contain 1–${MAX_QUERY_LENGTH} characters.`,
        );
      }
      const { signal, selection, sessionId } = options;
      signal?.throwIfAborted();
      const auto = selection === "auto";
      const preference = preferences.get(sessionId) ?? {};
      if (auto) preferences.set(sessionId, preference);
      const attempted = new Set<ProviderId>();

      while (true) {
        signal?.throwIfAborted();
        const available = providers.filter((provider) =>
          auto
            ? !attempted.has(provider.id) &&
              (cooldowns.get(provider.id) ?? 0) <= now()
            : provider.id === selection,
        );
        const provider =
          available.find((item) => item.id === preference.provider) ??
          available[Math.floor(random() * available.length)];
        if (!provider) {
          const until = Math.min(...cooldowns.values());
          const wait = Number.isFinite(until)
            ? Math.max(0, Math.ceil((until - now()) / 1000))
            : 0;
          throw new SearchError(
            auto
              ? `All web search providers are rate limited. ${wait ? `Try again in ${wait} seconds.` : "Try again shortly."}`
              : "Selected web search provider is unavailable.",
          );
        }
        attempted.add(provider.id);
        // Assign before awaiting. A late result must not overwrite another call's
        // replacement provider or restore a session cleared during this request.
        if (auto) preference.provider = provider.id;
        try {
          const results = await provider.search(text, signal);
          signal?.throwIfAborted();
          return {
            provider: provider.id,
            results: results.slice(0, MAX_RESULTS),
          };
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          if (auto && error instanceof SearchError && error.status === 429) {
            const until = now() + cooldownMillis(error.retryAfter, now());
            cooldowns.set(
              provider.id,
              Math.max(until, cooldowns.get(provider.id) ?? 0),
            );
            continue;
          }
          const message =
            error instanceof SearchError ? error.message : "Search failed.";
          throw new SearchError(`Web search via ${provider.id}: ${message}`);
        }
      }
    },
  };
}

function cooldownMillis(header: string | undefined, now: number): number {
  if (!header?.trim()) return 60_000;
  const value = header.trim();
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : 60_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 60_000;
}
