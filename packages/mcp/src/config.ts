import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface CommonServer {
  name: string;
  description: string;
  timeoutMs: number;
  approve: boolean;
}
export type ServerConfig = CommonServer &
  (
    | {
        type: "stdio";
        command: string;
        args: string[];
        env: Record<string, string>;
        cwd: string;
      }
    | { type: "http"; url: string; headers: Record<string, string> }
  );
export interface Config {
  path: string;
  servers: ServerConfig[];
}

function invalid(): never {
  // Never echo config values: URLs, headers, arguments, and even parse errors can contain secrets.
  throw new Error(
    "Invalid MCP configuration. See the pix-mcp README for supported fields.",
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
    invalid();
  return value;
}
function strings(
  value: unknown,
  env: NodeJS.ProcessEnv,
  kind: "env" | "headers" = "env",
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, entry] of Object.entries(object(value))) {
    // HTTP field names use token grammar, not environment-variable grammar;
    // the Headers constructor below validates them without leaking their values.
    if (kind === "env" && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) invalid();
    if (typeof entry !== "string" || entry.includes("\0")) invalid();
    result[key] = entry.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_match, name: string) => {
        const replacement = env[name];
        if (replacement === undefined)
          throw new Error(
            "MCP configuration references an unset environment variable.",
          );
        return replacement;
      },
    );
  }
  return result;
}

export async function readConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Config | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot read MCP configuration.");
  }
  if (Buffer.byteLength(source) > 256 * 1024) invalid();
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    invalid();
  }
  const root = object(value);
  if (Object.keys(root).some((key) => key !== "mcpServers")) invalid();
  const entries = Object.entries(object(root.mcpServers));
  if (entries.length > 32) invalid();
  const servers: ServerConfig[] = [];
  for (const [name, raw] of entries) {
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(name)) invalid();
    const server = object(raw);
    const allowed = new Set([
      "type",
      "command",
      "args",
      "env",
      "cwd",
      "url",
      "headers",
      "description",
      "timeoutMs",
      "approve",
      "disabled",
    ]);
    if (Object.keys(server).some((key) => !allowed.has(key))) invalid();
    if (server.disabled !== undefined && typeof server.disabled !== "boolean")
      invalid();
    if (server.disabled === true) continue;
    const type =
      server.type ?? (server.command !== undefined ? "stdio" : "http");
    const timeoutMs = server.timeoutMs ?? 30_000;
    if (
      !Number.isInteger(timeoutMs) ||
      typeof timeoutMs !== "number" ||
      timeoutMs < 100 ||
      timeoutMs > 120_000
    )
      invalid();
    if (server.approve !== undefined && typeof server.approve !== "boolean")
      invalid();
    const common: CommonServer = {
      name,
      description:
        server.description === undefined
          ? ""
          : text(server.description).slice(0, 500),
      timeoutMs,
      approve: server.approve !== false,
    };
    if (type === "stdio") {
      if (server.url !== undefined || server.headers !== undefined) invalid();
      const args = server.args ?? [];
      if (
        !Array.isArray(args) ||
        args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
      )
        invalid();
      servers.push({
        ...common,
        type,
        command: text(server.command),
        args,
        env: strings(server.env ?? {}, env),
        cwd:
          server.cwd === undefined
            ? dirname(path)
            : resolve(dirname(path), text(server.cwd)),
      });
    } else if (type === "http") {
      if (
        [server.command, server.args, server.env, server.cwd].some(
          (value) => value !== undefined,
        )
      )
        invalid();
      const url = text(server.url);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        invalid();
      }
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      )
        invalid();
      const headers = strings(server.headers ?? {}, env, "headers");
      try {
        new Headers(headers);
      } catch {
        invalid();
      }
      servers.push({ ...common, type, url, headers });
    } else invalid();
  }
  return { path, servers };
}
