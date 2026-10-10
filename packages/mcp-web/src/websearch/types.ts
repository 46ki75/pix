export const PROVIDER_IDS = [
  "exa",
  "parallel",
  "firecrawl",
  "tavily",
  "tinyfish",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type Selection = "auto" | "none" | ProviderId | readonly ProviderId[];

export const MAX_RESULTS = 8;
export const MAX_QUERY_LENGTH = 4_000;

export interface SearchResult {
  url: string;
  title?: string;
  content?: string;
  published?: number;
}

export interface SearchResponse {
  provider: ProviderId;
  results: SearchResult[];
}

export interface Provider {
  id: ProviderId;
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
}

export class SearchError extends Error {
  readonly status: number | undefined;
  readonly retryAfter: string | undefined;

  constructor(
    message: string,
    options: { status?: number; retryAfter?: string } = {},
  ) {
    super(message);
    this.name = "SearchError";
    this.status = options.status;
    this.retryAfter = options.retryAfter;
  }
}

export function selectionFromEnv(env: NodeJS.ProcessEnv): Selection {
  const value = env.PIX_WEBSEARCH_PROVIDER?.trim() || "auto";
  if (value === "auto" || value === "none") return value;
  const names = value.split(",").map((name) => name.trim());
  if (
    names.every((name): name is ProviderId =>
      PROVIDER_IDS.some((id) => id === name),
    )
  ) {
    const [first, ...rest] = new Set(names);
    if (first !== undefined) return rest.length ? [first, ...rest] : first;
  }
  throw new SearchError(
    `PIX_WEBSEARCH_PROVIDER must be auto, none, a provider name, or a comma-separated list of: ${PROVIDER_IDS.join(", ")}.`,
  );
}
