import { record } from "../http.ts";
import type { Provider } from "../types.ts";
import {
  array,
  bearer,
  mcpJson,
  optionalString,
  type ProviderOptions,
  result,
  string,
} from "./shared.ts";

export function parallel({ http, key }: ProviderOptions): Provider {
  return {
    id: "parallel",
    async search(query, signal) {
      const response = await http.callMcp(
        "https://search.parallel.ai/mcp",
        "web_search",
        { objective: query, search_queries: [query] },
        bearer(key),
        signal,
      );
      const data =
        response.structuredContent === undefined
          ? mcpJson(response)
          : record(response.structuredContent);
      return array(data.results).map((value) => {
        const item = record(value);
        return result(
          item.url,
          optionalString(item.title),
          array(item.excerpts).map(string).join("\n\n"),
          optionalString(item.publish_date),
        );
      });
    },
  };
}
