import type { SearchResponse } from "./types.ts";

export const MAX_OUTPUT_BYTES = 24 * 1024;

export function formatResults(response: SearchResponse): string {
  if (!response.results.length)
    return "No search results found. Try a different query.";
  let text = `Search provider: ${response.provider}`;
  const note =
    "\n\nResults shortened. Follow the source URLs for full content.";
  let shortened = false;
  for (const item of response.results) {
    const originalTitle = item.title ?? item.url;
    const shortTitle = prefix(originalTitle, 256);
    shortened ||= shortTitle !== originalTitle;
    const title = shortTitle
      .replace(/[\r\n]/g, " ")
      .replace(/([\\[\]])/g, "\\$1");
    const url = item.url.replace(/[\s<>]/g, (character) =>
      encodeURIComponent(character),
    );
    const heading = `\n\n## [${title}](<${url}>)${item.published === undefined ? "" : `\nPublished: ${new Date(item.published).toISOString()}`}`;
    if (Buffer.byteLength(`${text}${heading}${note}\n\n`) > MAX_OUTPUT_BYTES) {
      shortened = true;
      break;
    }
    text += heading;
    if (!item.content) continue;
    const remaining =
      MAX_OUTPUT_BYTES - Buffer.byteLength(`${text}${note}\n\n`);
    const excerpt = prefix(item.content, Math.min(2_000, remaining));
    shortened ||= excerpt !== item.content;
    text += `\n\n${excerpt}`;
  }
  return text + (shortened ? note : "");
}

function prefix(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  // Avoid cutting a multibyte code point when applying the model-output budget.
  let length = 0;
  let result = "";
  for (const character of text) {
    length += Buffer.byteLength(character);
    if (length > bytes) break;
    result += character;
  }
  return result;
}
