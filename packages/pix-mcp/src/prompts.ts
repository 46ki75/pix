import type {
  ContentBlock,
  GetPromptResult,
  Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import { compact } from "./catalog.ts";
import {
  quoteCommandArgument,
  renderCommandToken,
  tokenizeCommand,
  type CommandToken,
} from "./command.ts";
import { formatContent } from "./output.ts";

export interface PromptEntry {
  server: string;
  prompt: Prompt;
}

export type PromptArgumentToken = CommandToken;

export type PromptCommand =
  | { action: "list"; server?: string }
  | {
      action: "run";
      server: string;
      name: string;
      argumentTokens: PromptArgumentToken[];
    };

export function promptKey(server: string, name: string): string {
  return JSON.stringify([server, name]);
}

export function parsePromptCommand(input: string): PromptCommand {
  const tokens = tokenizeCommand(input, "prompt");
  const action = tokens.shift()?.value;
  if (action === "list") {
    if (tokens.length > 1) throw new Error("Usage: /mcp-prompt list [server]");
    const server = tokens[0]?.value;
    return { action, ...(server ? { server } : {}) };
  }
  if (action === "run") {
    const server = tokens.shift()?.value;
    const name = tokens.shift()?.value;
    if (!server || !name)
      throw new Error(
        "Usage: /mcp-prompt run <server> <prompt> [name=value ...]",
      );
    return { action, server, name, argumentTokens: tokens };
  }
  throw new Error(
    "Usage: /mcp-prompt list [server] | /mcp-prompt run <server> <prompt> [name=value ...]",
  );
}

export function resolvePromptArguments(
  prompt: Prompt,
  tokens: (PromptArgumentToken | string)[],
): Record<string, string> | undefined {
  const declared = new Set(
    (prompt.arguments ?? []).map((argument) => argument.name),
  );
  const named = new Map<string, string>();
  const positional: string[] = [];
  for (const token of tokens) {
    const value = typeof token === "string" ? token : token.value;
    const separator =
      typeof token === "string" ? token.indexOf("=") : token.separator;
    const candidate = value.slice(0, separator);
    if (separator !== undefined && separator > 0 && declared.has(candidate)) {
      const name = candidate;
      if (named.has(name))
        throw new Error(`Prompt argument ${name} was provided more than once.`);
      named.set(name, value.slice(separator + 1));
    } else positional.push(value);
  }

  const result = Object.create(null) as Record<string, string>;
  let position = 0;
  for (const argument of prompt.arguments ?? []) {
    const namedValue = named.get(argument.name);
    const value = namedValue ?? positional[position];
    if (namedValue === undefined && value !== undefined) position++;
    if (value !== undefined) result[argument.name] = value;
    named.delete(argument.name);
  }
  if (position < positional.length)
    throw new Error("Too many positional prompt arguments were provided.");
  for (const [name, value] of named) result[name] = value;

  const missing = (prompt.arguments ?? [])
    .filter(
      (argument) =>
        argument.required === true && !Object.hasOwn(result, argument.name),
    )
    .map((argument) => argument.name);
  if (missing.length > 0)
    throw new Error(
      `Missing required prompt arguments: ${missing.join(", ")}.`,
    );
  return Object.keys(result).length > 0 ? result : undefined;
}

export function formatPromptList(
  entries: PromptEntry[],
  server?: string,
): string {
  const selected = entries
    .filter((entry) => !server || entry.server === server)
    .sort(
      (a, b) =>
        a.server.localeCompare(b.server, "en") ||
        a.prompt.name.localeCompare(b.prompt.name, "en"),
    );
  if (selected.length === 0)
    return server
      ? `No MCP prompts are available from ${server}.`
      : "No MCP prompts are available.";
  const lines = ["Available MCP prompts:"];
  let shown = 0;
  for (const entry of selected) {
    const argumentsHint = (entry.prompt.arguments ?? [])
      .map((argument) =>
        argument.required
          ? `<${quoteCommandArgument(argument.name)}>`
          : `[${quoteCommandArgument(argument.name)}]`,
      )
      .join(" ");
    const description = compact(
      entry.prompt.description ?? entry.prompt.title ?? "",
      160,
    );
    const line = `${entry.server} ${quoteCommandArgument(entry.prompt.name)}${argumentsHint ? ` ${argumentsHint}` : ""}${description ? ` — ${description}` : ""}`;
    if (shown >= 100 || lines.join("\n").length + line.length > 15_000) {
      lines.push(`${selected.length - shown} additional prompts omitted.`);
      break;
    }
    lines.push(line);
    shown++;
  }
  lines.push(
    "Run one with /mcp-prompt run <server> <prompt> [name=value ...].",
  );
  return lines.join("\n");
}

export function promptCompletions(
  prefix: string,
  entries: PromptEntry[],
): { value: string; label: string; description?: string }[] | null {
  const trailingSpace = /\s$/.test(prefix);
  let tokens: PromptArgumentToken[];
  try {
    tokens = tokenizeCommand(prefix);
  } catch {
    return null;
  }
  if (tokens.length === 0)
    return [
      { value: "list", label: "list", description: "List MCP prompts" },
      { value: "run", label: "run", description: "Run an MCP prompt" },
    ];
  if (tokens.length === 1 && !trailingSpace) {
    return ["list", "run"]
      .filter((action) => action.startsWith(tokens[0]?.value ?? ""))
      .map((action) => ({ value: action, label: action }));
  }
  const action = tokens[0]?.value;
  if (action !== "list" && action !== "run") return null;
  const servers = [...new Set(entries.map((entry) => entry.server))].sort();
  const completingServer =
    tokens.length === 1 || (tokens.length === 2 && !trailingSpace);
  if (completingServer) {
    const current = trailingSpace ? "" : (tokens[1]?.value ?? "");
    return completionItems(
      servers.filter((server) => server.startsWith(current)),
      `${action} `,
      (server) => server,
    );
  }
  if (action === "list") return null;
  const server = tokens[1]?.value;
  if (!server || !servers.includes(server)) return null;
  if (
    (tokens.length === 2 && trailingSpace) ||
    (tokens.length === 3 && !trailingSpace)
  ) {
    const current = trailingSpace ? "" : (tokens[2]?.value ?? "");
    const prompts = entries
      .filter(
        (entry) =>
          entry.server === server && entry.prompt.name.startsWith(current),
      )
      .sort((a, b) => a.prompt.name.localeCompare(b.prompt.name, "en"));
    return prompts.map((entry) => ({
      value: `run ${quoteCommandArgument(server)} ${quoteCommandArgument(entry.prompt.name)}`,
      label: entry.prompt.name,
      ...(entry.prompt.description || entry.prompt.title
        ? {
            description: compact(
              entry.prompt.description ?? entry.prompt.title ?? "",
              100,
            ),
          }
        : {}),
    }));
  }
  const name = tokens[2]?.value;
  const selected = entries.find(
    (entry) => entry.server === server && entry.prompt.name === name,
  );
  if (!selected) return null;
  const supplied = tokens.slice(3);
  const currentToken = trailingSpace ? undefined : supplied.pop();
  const current = currentToken?.value ?? "";
  if (currentToken?.separator !== undefined) return null;
  const definitions = selected.prompt.arguments ?? [];
  const declared = new Set(definitions.map((argument) => argument.name));
  const named = new Set<string>();
  let positional = 0;
  for (const token of supplied) {
    const candidate = token.value.slice(0, token.separator);
    if (
      token.separator !== undefined &&
      token.separator > 0 &&
      declared.has(candidate)
    )
      named.add(candidate);
    else positional++;
  }
  const satisfied = new Set<string>();
  let position = 0;
  for (const argument of definitions) {
    if (named.has(argument.name)) satisfied.add(argument.name);
    else if (position < positional) {
      satisfied.add(argument.name);
      position++;
    }
  }
  const base = [
    "run",
    quoteCommandArgument(server),
    quoteCommandArgument(selected.prompt.name),
    ...supplied.map(renderCommandToken),
  ].join(" ");
  const arguments_ = definitions.filter(
    (argument) =>
      !satisfied.has(argument.name) && argument.name.startsWith(current),
  );
  return arguments_.length > 0
    ? arguments_.map((argument) => ({
        value: `${base} ${quoteCommandArgument(argument.name)}=`,
        label: `${argument.name}=`,
        ...(argument.description
          ? { description: compact(argument.description, 100) }
          : {}),
      }))
    : null;
}

function completionItems(
  values: string[],
  prefix: string,
  label: (value: string) => string,
) {
  return values.map((value) => ({
    value: `${prefix}${quoteCommandArgument(value)}`,
    label: label(value),
  }));
}

function hasUsablePromptContent(
  content: GetPromptResult["messages"][number]["content"],
): boolean {
  if (content.type === "text") return content.text.trim().length > 0;
  if (content.type === "resource")
    return "text" in content.resource
      ? content.resource.text.trim().length > 0
      : content.resource.blob.length > 0;
  if (content.type === "resource_link") return content.uri.trim().length > 0;
  return content.data.length > 0;
}

export async function formatPromptResult(result: GetPromptResult) {
  if (result.messages.length === 0)
    throw new Error("MCP prompt returned no messages.");
  const blocks: ContentBlock[] = [];
  let hasSourceContent = false;
  const showRoles =
    result.messages.length > 1 || result.messages[0]?.role !== "user";
  for (const message of result.messages) {
    if (showRoles) blocks.push({ type: "text", text: `[${message.role}]` });
    const content = message.content;
    if (hasUsablePromptContent(content)) hasSourceContent = true;
    if (content.type === "resource") {
      if ("text" in content.resource) {
        blocks.push({
          type: "text",
          text: `[MCP embedded resource ${content.resource.uri}]\n${content.resource.text}`,
        });
      } else if (
        content.resource.mimeType &&
        ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          content.resource.mimeType,
        )
      ) {
        blocks.push({
          type: "image",
          data: content.resource.blob,
          mimeType: content.resource.mimeType,
        });
      } else blocks.push(content);
    } else if (content.type === "resource_link") {
      blocks.push({
        type: "text",
        text: `[MCP resource link ${content.name}: ${content.uri}]`,
      });
    } else blocks.push(content);
  }
  if (!hasSourceContent)
    throw new Error("MCP prompt returned no usable content.");
  const formatted = await formatContent(blocks, {
    artifact: result,
    preserveOrder: true,
  });
  if (formatted.content.length === 0)
    throw new Error("MCP prompt returned no usable content.");
  return formatted;
}
