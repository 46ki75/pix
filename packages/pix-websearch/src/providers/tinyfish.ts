import { record } from "../http.ts";
import type { Provider } from "../types.ts";
import {
  array,
  mcpJson,
  type ProviderOptions,
  result,
  string,
} from "./shared.ts";

export function tinyfish({ http, key }: ProviderOptions): Provider {
  return {
    id: "tinyfish",
    async search(query, signal) {
      const response = mcpJson(
        await http.callMcp(
          "https://agent.tinyfish.ai/mcp",
          "search",
          { query },
          key ? { "X-API-Key": key } : { "X-TinyFish-Access-Mode": "keyless" },
          signal,
        ),
      );
      return array(response.results).map((value) => {
        const item = record(value);
        return result(item.url, string(item.title), string(item.snippet));
      });
    },
  };
}
