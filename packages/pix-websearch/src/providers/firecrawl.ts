import { record } from "../http.ts";
import { MAX_RESULTS, type Provider, SearchError } from "../types.ts";
import {
  array,
  bearer,
  mcpJson,
  optionalString,
  type ProviderOptions,
  result,
} from "./shared.ts";

export function firecrawl({ http, key }: ProviderOptions): Provider {
  return {
    id: "firecrawl",
    async search(query, signal) {
      const response = mcpJson(
        await http.callMcp(
          "https://mcp.firecrawl.dev/v2/mcp",
          "firecrawl_search",
          { query, limit: MAX_RESULTS },
          bearer(key),
          signal,
        ),
      );
      if (response.success !== true)
        throw new SearchError("Firecrawl search failed.");
      return array(record(response.data).web).map((value) => {
        const item = record(value);
        return result(
          item.url,
          optionalString(item.title),
          optionalString(item.description),
        );
      });
    },
  };
}
