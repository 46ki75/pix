import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createArtifactStore } from "./artifacts.ts";
import { extractContent } from "./extract.ts";
import { createWebFetch, MAX_URL_LENGTH } from "./fetch.ts";
import { formatPage } from "./output.ts";

export default function webfetch(pi: ExtensionAPI) {
  const fetch = createWebFetch();
  const artifacts = createArtifactStore();
  pi.registerTool({
    name: "webfetch",
    label: "Web Fetch",
    description:
      "Fetch an HTTP(S) URL. Converts static HTML to Markdown by default, or readable text; preserves other text formats. Does not execute JavaScript. Output is limited to 24 KiB; full converted output is saved to a temporary file when truncated.",
    promptSnippet: "Read a web page or text resource at a known URL.",
    promptGuidelines: [
      "Use webfetch to read source pages in detail. Cite source URLs when using their content.",
      "When webfetch output is truncated, use read with the full output path and offset/limit to inspect further sections.",
    ],
    parameters: Type.Object({
      url: Type.String({
        minLength: 1,
        maxLength: MAX_URL_LENGTH,
        description: "HTTP(S) URL to fetch",
      }),
      format: Type.Optional(
        Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
          description:
            "HTML output format (default: markdown); other text formats pass through",
        }),
      ),
    }),
    async execute(_toolCallId, { url, format = "markdown" }, signal) {
      const page = await fetch(url, signal, format);
      signal?.throwIfAborted();
      const result = await formatPage(
        page,
        extractContent(page, format),
        format,
        artifacts.save,
        signal,
      );
      return {
        content: [{ type: "text", text: result.content }],
        details: result.details,
      };
    },
  });
}
