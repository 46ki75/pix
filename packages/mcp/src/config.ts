import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const MAX_TIMEOUT_MS = 2_147_483_647;

export interface CommonServer {
  name: string;
  description: string;
  timeout: number;
  startupTimeoutMs: number;
  catalogTimeoutMs: number;
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
export interface ConfigIssue {
  name: string;
  field?: string;
  message: string;
}
export interface Config {
  path: string;
  servers: ServerConfig[];
  issues: ConfigIssue[];
}

class ConfigError extends Error {
  readonly field: string | undefined;
  constructor(message: string, field?: string) {
    // Only fixed messages and known field names belong here, never input values.
    super(`Invalid MCP configuration. ${field ? `${field}: ` : ""}${message}`);
    this.field = field;
  }
}
function invalid(
  field?: string,
  message = "See the pix-mcp README for supported fields.",
): never {
  throw new ConfigError(message, field);
}
function object(value: unknown, field?: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(field, "Expected an object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && value.length === 0) ||
    value.includes("\0")
  )
    invalid(field, "Expected a valid string.");
  return value;
}
function expand(
  value: unknown,
  env: NodeJS.ProcessEnv,
  field: string,
  empty = false,
): string {
  const expanded = text(value, field, empty).replace(
    /\$\{([^}]*)\}|\$\{/g,
    (_match, expression: string | undefined) => {
      const match = expression?.match(
        /^([A-Za-z_][A-Za-z0-9_]*)(?::-([\s\S]*))?$/,
      );
      if (!match?.[1])
        invalid(
          field,
          `Use \${VAR} or \${VAR:-default} environment references.`,
        );
      const replacement =
        (Object.hasOwn(env, match[1]) ? env[match[1]] : undefined) ?? match[2];
      if (replacement === undefined)
        invalid(field, "References an unset environment variable.");
      return replacement;
    },
  );
  return text(expanded, field, empty);
}
function strings(
  value: unknown,
  env: NodeJS.ProcessEnv,
  field: "env" | "headers",
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, entry] of Object.entries(object(value, field))) {
    if (field === "env" && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key))
      invalid(field, "Invalid environment variable name.");
    result[key] = expand(entry, env, field, true);
  }
  return result;
}
function timeout(value: unknown, field: string): number {
  if (value === undefined) return 30_000;
  // Node timers overflow above this bound and can fire almost immediately.
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  )
    invalid(
      field,
      `Expected an integer from 1 through ${MAX_TIMEOUT_MS} milliseconds.`,
    );
  return value;
}

function parseServer(
  name: string,
  raw: unknown,
  path: string,
  env: NodeJS.ProcessEnv,
): ServerConfig | undefined {
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(name))
    invalid(
      undefined,
      "Server names must contain 1–48 ASCII letters, digits, underscores, or hyphens.",
    );
  const server = object(raw);
  if (Object.hasOwn(server, "timeoutMs"))
    invalid(
      "timeoutMs",
      "Removed; use timeout for tool calls, startupTimeoutMs for initialization, and catalogTimeoutMs for discovery (milliseconds).",
    );
  if (Object.hasOwn(server, "approve"))
    invalid(
      "approve",
      "Removed; delete approve and use a Pi tool_call extension for permission controls.",
    );
  const allowed = new Set([
    "type",
    "command",
    "args",
    "env",
    "cwd",
    "url",
    "headers",
    "description",
    "timeout",
    "startupTimeoutMs",
    "catalogTimeoutMs",
    "disabled",
  ]);
  if (Object.keys(server).some((key) => !allowed.has(key)))
    invalid(
      undefined,
      "Unsupported server field. See the pix-mcp README for supported fields.",
    );
  if (server.disabled !== undefined && typeof server.disabled !== "boolean")
    invalid("disabled", "Expected a boolean.");
  if (server.disabled === true) return undefined;
  const common: CommonServer = {
    name,
    description:
      server.description === undefined
        ? ""
        : text(server.description, "description").slice(0, 500),
    timeout: timeout(server.timeout, "timeout"),
    startupTimeoutMs: timeout(server.startupTimeoutMs, "startupTimeoutMs"),
    catalogTimeoutMs: timeout(server.catalogTimeoutMs, "catalogTimeoutMs"),
  };
  const type =
    server.type === undefined && server.command !== undefined
      ? "stdio"
      : server.type;
  if (type === "stdio") {
    if (server.url !== undefined || server.headers !== undefined)
      invalid("type", "Stdio servers cannot use url or headers.");
    const args = server.args === undefined ? [] : server.args;
    if (!Array.isArray(args)) invalid("args", "Expected an array of strings.");
    return {
      ...common,
      type,
      command: expand(server.command, env, "command"),
      args: args.map((arg) => expand(arg, env, "args", true)),
      env: strings(server.env === undefined ? {} : server.env, env, "env"),
      cwd:
        server.cwd === undefined
          ? dirname(path)
          : resolve(dirname(path), expand(server.cwd, env, "cwd")),
    };
  }
  if (type !== "http" && type !== "streamable-http")
    invalid(
      "type",
      "Use stdio, http, or streamable-http. Remote servers require an explicit type.",
    );
  if (
    [server.command, server.args, server.env, server.cwd].some(
      (value) => value !== undefined,
    )
  )
    invalid("type", "HTTP servers cannot use command, args, env, or cwd.");
  const url = expand(server.url, env, "url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    invalid(
      "url",
      "Expected an HTTP(S) URL without credentials or a fragment.",
    );
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    invalid(
      "url",
      "Expected an HTTP(S) URL without credentials or a fragment.",
    );
  const headers = strings(
    server.headers === undefined ? {} : server.headers,
    env,
    "headers",
  );
  try {
    new Headers(headers);
  } catch {
    invalid("headers", "Invalid HTTP header name or value.");
  }
  return { ...common, type: "http", url, headers };
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
  if (Buffer.byteLength(source) > 256 * 1024)
    invalid(undefined, "Configuration exceeds 256 KiB.");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    invalid(undefined, "Malformed JSON.");
  }
  const root = object(value);
  if (
    Object.keys(root).some((key) => key !== "mcpServers" && key !== "$schema")
  )
    invalid(
      undefined,
      "Unsupported root field; use mcpServers and optional $schema.",
    );
  // Editor metadata only: never fetch a configuration-provided schema URL.
  if (root.$schema !== undefined) text(root.$schema, "$schema");
  const entries = Object.entries(object(root.mcpServers, "mcpServers"));
  if (entries.length > 32)
    invalid("mcpServers", "At most 32 servers are supported.");
  const servers: ServerConfig[] = [];
  const issues: ConfigIssue[] = [];
  for (const [index, [name, raw]] of entries.entries()) {
    try {
      const server = parseServer(name, raw, path, env);
      if (server) servers.push(server);
    } catch (error) {
      // Invalid names and unknown keys can themselves contain credentials. Only
      // validated names and our fixed validation messages reach discovery.
      issues.push({
        name: /^[A-Za-z0-9_-]{1,48}$/.test(name)
          ? name
          : `Invalid server #${index + 1}`,
        ...(error instanceof ConfigError && error.field
          ? { field: error.field }
          : {}),
        message:
          error instanceof ConfigError
            ? error.message
            : "Invalid MCP configuration. Server could not be validated.",
      });
    }
  }
  return { path, servers, issues };
}
