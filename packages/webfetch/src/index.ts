import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractText } from "./extract.ts";
import { createWebFetch, MAX_URL_LENGTH } from "./fetch.ts";
import { formatPage } from "./output.ts";

export default function webfetch(pi: ExtensionAPI) {
  const fetch = createWebFetch();
  pi.registerTool({
    name: "webfetch",
    label: "Web Fetch",
    description:
      "Fetch an HTTP(S) URL and return readable text. Converts static HTML to text with source links; preserves other text formats. Does not execute JavaScript. Output may be truncated.",
    promptSnippet: "Read a web page or text resource at a known URL.",
    promptGuidelines: [
      "Use webfetch to read source pages in detail. Cite source URLs when using their content.",
    ],
    parameters: Type.Object({
      url: Type.String({
        minLength: 1,
        maxLength: MAX_URL_LENGTH,
        description: "HTTP(S) URL to fetch",
      }),
    }),
    async execute(_toolCallId, { url }, signal) {
      const page = await fetch(url, signal);
      signal?.throwIfAborted();
      const result = formatPage(page, extractText(page));
      return {
        content: [{ type: "text", text: result.content }],
        details: result.details,
      };
    },
  });
}
