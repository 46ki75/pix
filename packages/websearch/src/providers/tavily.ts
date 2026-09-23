import { record } from "../http.ts";
import { MAX_RESULTS, type Provider } from "../types.ts";
import {
  array,
  bearer,
  type ProviderOptions,
  result,
  string,
} from "./shared.ts";

export function tavily({ http, key }: ProviderOptions): Provider {
  return {
    id: "tavily",
    async search(query, signal) {
      const response = record(
        await http.postJson(
          "https://api.tavily.com/search",
          {
            query,
            search_depth: "basic",
            chunks_per_source: 3,
            max_results: MAX_RESULTS,
          },
          {
            "X-Client-Name": "pix-websearch",
            ...(key ? bearer(key) : { "X-Tavily-Access-Mode": "keyless" }),
          },
          signal,
        ),
      );
      return array(response.results).map((value) => {
        const item = record(value);
        return result(item.url, string(item.title), string(item.content));
      });
    },
  };
}
