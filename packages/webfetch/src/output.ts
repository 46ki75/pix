import type { FetchedPage } from "./fetch.ts";

export const MAX_OUTPUT_BYTES = 24 * 1024;

export function formatPage(page: FetchedPage, text: string) {
  const header = `URL: ${page.url}\nContent-Type: ${page.contentType}\n\n`;
  const body = text.trim() ? text : "No readable text found in the response.";
  const note = "\n\n[Content truncated to the webfetch output limit.]";
  const truncated = Buffer.byteLength(header + body) > MAX_OUTPUT_BYTES;
  const content = truncated
    ? prefix(header + body, MAX_OUTPUT_BYTES - Buffer.byteLength(note)) + note
    : header + body;
  return {
    content,
    details: {
      url: page.url,
      contentType: page.contentType,
      responseBytes: page.responseBytes,
      truncated,
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
  return text.slice(0, end);
}
