import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatResults } from "./output.ts";
import { createProviders } from "./providers/index.ts";
import { createSearch } from "./search.ts";
import { MAX_QUERY_LENGTH, selectionFromEnv } from "./types.ts";

export default function websearch(pi: ExtensionAPI) {
  const search = createSearch(createProviders());
  pi.on("session_start", async () => search.clearSessions());
  pi.on("session_shutdown", async () => search.clearSessions());

  pi.registerTool({
    name: "websearch",
    label: "Web Search",
    description: `Search the web for current information and return source links and excerpts. The current year is ${new Date().getFullYear()}.`,
    promptSnippet: "Search the web for current information with source links.",
    promptGuidelines: ["Cite source URLs when using web search results."],
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: MAX_QUERY_LENGTH,
        description: "Web search query",
      }),
    }),
    async execute(_toolCallId, { query }, signal, _onUpdate, ctx) {
      const response = await search.search(query, {
        selection: selectionFromEnv(process.env),
        sessionId: ctx.sessionManager.getSessionId(),
        ...(signal ? { signal } : {}),
      });
      return {
        content: [{ type: "text", text: formatResults(response) }],
        details: response,
      };
    },
  });
}
