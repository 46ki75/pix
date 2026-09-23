import type { SaveArtifact } from "./artifacts.ts";
import type { FetchedPage, FetchFormat } from "./fetch.ts";
import { isHtml } from "./html.ts";

export const MAX_OUTPUT_BYTES = 24 * 1024;

export async function formatPage(
  page: FetchedPage,
  text: string,
  format: FetchFormat,
  save: SaveArtifact,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const header = `URL: ${page.url}\nContent-Type: ${page.contentType}\n\n`;
  const body = text.trim() ? text : "No readable text found in the response.";
  const truncated = Buffer.byteLength(header + body) > MAX_OUTPUT_BYTES;
  let content = header + body;
  let fullOutputPath: string | undefined;
  if (truncated) {
    const extension =
      page.contentType === "text/markdown" ||
      (isHtml(page.contentType) && format === "markdown")
        ? "md"
        : "txt";
    fullOutputPath = await save(content, extension, signal);
    const note = `\n\n[Content truncated. Full output: ${fullOutputPath}\nUse read with offset/limit to continue.]`;
    const budget = MAX_OUTPUT_BYTES - Buffer.byteLength(note);
    // Untrusted metadata can exhaust the preview budget before the body starts.
    const preview =
      Buffer.byteLength(header) > budget
        ? prefix(content, budget)
        : header + prefix(body, budget - Buffer.byteLength(header));
    content = preview + note;
  }
  return {
    content,
    details: {
      url: page.url,
      contentType: page.contentType,
      responseBytes: page.responseBytes,
      truncated,
      ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
    },
  };
}

function prefix(text: string, bytes: number): string {
  let size = 0;
  let end = 0;
  for (const character of text) {
    size += Buffer.byteLength(character);
    if (size > bytes) break;
    end += character.length;
  }
  const result = text.slice(0, end);
  const newline = result.lastIndexOf("\n");
  return newline > 0 ? result.slice(0, newline) : result;
}
