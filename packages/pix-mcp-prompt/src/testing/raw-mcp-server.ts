import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const configuredLogPath = process.env.PIX_MCP_FIXTURE_LOG;
if (!configuredLogPath) throw new Error("PIX_MCP_FIXTURE_LOG is required");
const logPath: string = configuredLogPath;

const label = process.env.PIX_MCP_FIXTURE_LABEL ?? "fixture";
const revision = process.env.PIX_MCP_FIXTURE_REVISION ?? "1";
let catalogRevision = 1;
let sequence = 0;

function record(event: string, details: Record<string, unknown> = {}): void {
  appendFileSync(
    logPath,
    `${JSON.stringify({
      event,
      pid: process.pid,
      label,
      revision,
      sequence: sequence++,
      ...details,
    })}\n`,
  );
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function promptCatalog(): Record<string, unknown>[] {
  return [
    {
      name: "review",
      title: "Review a topic",
      description: `${label} review prompt`,
      arguments: [
        { name: "topic", description: "Topic to review", required: true },
        { name: "tone", description: "Optional response tone" },
      ],
    },
    ...(catalogRevision === 1
      ? [{ name: "stale", description: "Changes while being retrieved" }]
      : []),
    { name: "blocked", description: "Waits until its request is cancelled" },
  ];
}

function handleRequest(message: JsonRpcMessage): void {
  const method = message.method;
  const params = object(message.params);
  record("request", {
    id: message.id,
    method,
    params,
    ...(method === "initialize"
      ? { clientInfo: object(params.clientInfo) }
      : {}),
  });

  switch (method) {
    case "initialize":
      respond(message.id, {
        protocolVersion:
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2025-11-25",
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
        },
        serverInfo: { name: `raw-fixture-${label}`, version: revision },
        instructions: `Raw ${label} integration fixture`,
      });
      return;
    case "ping":
      respond(message.id, {});
      return;
    case "tools/list":
      respond(message.id, {
        tools: [
          {
            name: "echo",
            description: `Echo from ${label}`,
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
              additionalProperties: false,
            },
          },
        ],
      });
      return;
    case "tools/call": {
      const arguments_ = object(params.arguments);
      respond(message.id, {
        content: [
          {
            type: "text",
            text: `${label}:${String(arguments_.message ?? "")}`,
          },
        ],
        structuredContent: { message: arguments_.message },
      });
      return;
    }
    case "resources/list":
      respond(message.id, {
        resources: [
          {
            uri: `fixture://${label}`,
            name: `${label} notes`,
            description: `${label} integration resource`,
            mimeType: "text/plain",
          },
        ],
      });
      return;
    case "resources/templates/list":
      respond(message.id, { resourceTemplates: [] });
      return;
    case "resources/read":
      respond(message.id, {
        contents: [
          {
            uri: String(params.uri ?? ""),
            mimeType: "text/plain",
            text: `Resource from ${label} revision ${revision}`,
          },
        ],
      });
      return;
    case "prompts/list":
      respond(message.id, { prompts: promptCatalog() });
      return;
    case "prompts/get": {
      const name = params.name;
      if (name === "blocked") return;
      if (name === "stale") {
        catalogRevision++;
        send({
          jsonrpc: "2.0",
          method: "notifications/prompts/list_changed",
        });
        respond(message.id, {
          messages: [
            {
              role: "user",
              content: { type: "text", text: "Stale prompt response" },
            },
          ],
        });
        return;
      }
      if (name !== "review") {
        fail(message.id, -32602, "Unknown prompt");
        return;
      }
      const arguments_ = object(params.arguments);
      const topic = String(arguments_.topic ?? "");
      const tone =
        arguments_.tone === undefined ? undefined : String(arguments_.tone);
      respond(message.id, {
        description: `Rendered by ${label}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                topic === "command"
                  ? "!echo unsafe"
                  : `Review ${topic}${tone ? ` in a ${tone} tone` : ""}.`,
            },
          },
        ],
      });
      return;
    }
    default:
      fail(message.id, -32601, `Method not found: ${String(method)}`);
  }
}

function handleLine(line: string): void {
  if (!line.trim()) return;
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(line) as JsonRpcMessage;
  } catch {
    record("invalid_json", { line });
    return;
  }
  if (typeof message.method !== "string") return;
  if (message.id === undefined) {
    record("notification", {
      method: message.method,
      params: object(message.params),
    });
    return;
  }
  handleRequest(message);
}

record("start");
createInterface({ input: process.stdin }).on("line", handleLine);
process.stdin.once("end", () => {
  record("stdin_end");
  process.exit(0);
});
process.once("SIGINT", () => {
  record("signal", { signal: "SIGINT" });
  process.exit(130);
});
process.once("SIGTERM", () => {
  record("signal", { signal: "SIGTERM" });
  process.exit(143);
});
process.once("exit", (code) => record("exit", { code }));
