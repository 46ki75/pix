import { MAX_RESULTS, type Provider, SearchError } from "../types.ts";
import { mcpText, type ProviderOptions, result } from "./shared.ts";

export function exa({ http, key }: ProviderOptions): Provider {
  return {
    id: "exa",
    async search(query, signal) {
      const response = await http.callMcp(
        "https://mcp.exa.ai/mcp",
        "web_search_exa",
        { query, numResults: MAX_RESULTS },
        key ? { "x-api-key": key } : {},
        signal,
      );
      const text = mcpText(response).trim();
      if (!text || /^No (?:search )?results found\./i.test(text)) return [];
      return text.split(/\r?\n\r?\n---\r?\n\r?\n/).map((block) => {
        const field = (name: string) =>
          block.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "m"))?.[1]?.trim();
        const url = field("URL");
        if (!url) throw new SearchError("Invalid Exa search result format.");
        const title = field("Title");
        return result(
          url,
          title === "N/A" ? undefined : title,
          block
            .match(/^(?:Highlights|Text):[ \t]*\r?\n?([\s\S]*)$/m)?.[1]
            ?.trim(),
          field("Published"),
        );
      });
    },
  };
}
