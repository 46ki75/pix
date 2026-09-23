import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface Entry {
  name: string;
  server: string;
  tool: Tool;
  fingerprint: string;
}

export function toolName(server: string, original: string): string {
  const suffix = createHash("sha256")
    .update(JSON.stringify([server, original]))
    .digest("hex")
    .slice(0, 12);
  const readable = `${server}_${original}`
    .replace(/[^A-Za-z0-9_]/g, "_")
    .slice(0, 47);
  return `mcp_${readable}_${suffix}`;
}

export function entry(server: string, tool: Tool): Entry {
  return {
    name: toolName(server, tool.name),
    server,
    tool,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(tool))
      .digest("hex"),
  };
}

export function search(
  entries: Entry[],
  query: string,
  server?: string,
): Entry[] {
  const words = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter(Boolean),
    ),
  ];
  if (!words.length) return [];
  return entries
    .filter((item) => !server || item.server === server)
    .map((item) => {
      const name =
        `${item.server} ${item.tool.name} ${item.name}`.toLowerCase();
      const description = (item.tool.description ?? "").toLowerCase();
      const score = words.reduce(
        (sum, word) =>
          sum +
          (name.includes(word) ? 4 : 0) +
          (description.includes(word) ? 1 : 0),
        0,
      );
      return { item, score };
    })
    .filter((match) => match.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.item.name.localeCompare(b.item.name, "en"),
    )
    .map((match) => match.item);
}

export function summary(item: Entry) {
  return {
    name: item.name,
    server: item.server,
    tool: item.tool.name,
    description: compact(item.tool.description ?? "", 200),
  };
}

export function compact(value: string, limit: number): string {
  const text = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
