import { type Http, parseJson, record } from "../http.ts";
import { SearchError, type SearchResult } from "../types.ts";

export interface ProviderOptions {
  http: Http;
  key: string | undefined;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new SearchError("Invalid search result list.");
  return value;
}

export function string(value: unknown): string {
  if (typeof value !== "string")
    throw new SearchError("Invalid search result text.");
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : string(value);
}

export function result(
  url: unknown,
  title?: string,
  content?: string,
  published?: string,
): SearchResult {
  const href = string(url);
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      throw new Error();
  } catch {
    throw new SearchError("Invalid search result URL.");
  }
  const date = published ? Date.parse(published) : Number.NaN;
  return {
    url: href,
    ...(title ? { title } : {}),
    ...(content ? { content } : {}),
    ...(Number.isFinite(date) ? { published: date } : {}),
  };
}

export function mcpText(response: Record<string, unknown>): string {
  const content = array(response.content)
    .map(record)
    .filter((item) => item.type === "text")
    .map((item) => string(item.text));
  if (!content.length) throw new SearchError("Missing MCP search content.");
  return content.join("\n");
}

export function mcpJson(
  response: Record<string, unknown>,
): Record<string, unknown> {
  return record(parseJson(mcpText(response)));
}

export function bearer(key: string | undefined): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}
