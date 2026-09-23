import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=";

export const legacySchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object" as const,
  definitions: { text: { type: "string" } },
  properties: { message: { $ref: "#/definitions/text", type: "number" } },
  required: ["message"],
};

export const eagleSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object" as const,
  properties: {
    message: { type: "string", minLength: 3 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
    tags: { type: "array", items: { type: "string" }, maxItems: 3 },
  },
  required: ["message"],
  additionalProperties: false,
};

export function fixtureServer() {
  let changed = false;
  let revised = false;
  const calls: string[] = [];
  const server = new Server(
    { name: "fixture", version: "1" },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: "Fixture tools for testing echo and lifecycle behavior.",
    },
  );
  const tool = (name: string): Tool => ({
    name,
    description: `${name} fixture tool`,
    ...(name === "fail"
      ? { outputSchema: { type: "object" as const, required: ["message"] } }
      : {}),
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          ...(revised && name === "echo" ? { minLength: 3 } : {}),
        },
        delay: { type: "integer", minimum: 0 },
      },
      required: ["message"],
      additionalProperties: false,
    },
  });
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (process.env.PIX_FIXTURE_BROKEN === "true")
      throw new Error("SECRET fixture discovery error");
    if (request.params?.cursor === "page2")
      return {
        tools: [tool("slow"), tool("fail"), tool("large"), tool("change")],
      };
    // Keep fixture wire data independent of SDK Tool's incorrect object-only
    // property-schema type so legal boolean schemas can exercise the decoder.
    const tools: Record<string, unknown>[] = [
      tool(changed ? "echo_v2" : "echo"),
    ];
    if (process.env.PIX_FIXTURE_INVALID_SCHEMA === "true")
      tools.push({
        name: "invalid",
        inputSchema: {
          type: "object",
          properties: { value: { type: "not-a-json-schema-type" } },
        },
      });
    if (process.env.PIX_FIXTURE_LEGACY_SCHEMA === "true")
      tools.push({ name: "legacy", inputSchema: legacySchema });
    if (process.env.PIX_FIXTURE_DRAFT07_SCHEMA === "true")
      tools.push(
        {
          name: "eagle_search",
          inputSchema: {
            ...eagleSchema,
            properties: {
              ...eagleSchema.properties,
              message: { type: "string", minLength: revised ? 5 : 3 },
            },
          },
        },
        {
          name: "ai_search_status",
          inputSchema: {
            $schema: eagleSchema.$schema,
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      );
    if (process.env.PIX_FIXTURE_UNSAFE_SCHEMAS === "true")
      tools.push(
        {
          name: "unsafe_const",
          inputSchema: {
            $schema: eagleSchema.$schema,
            type: "object",
            properties: { value: { const: [] } },
          },
        },
        {
          name: "unsafe_enum",
          inputSchema: {
            $schema: eagleSchema.$schema,
            type: "object",
            properties: { value: { enum: [[]] } },
          },
        },
        {
          name: "unsafe_pattern",
          inputSchema: {
            $schema: eagleSchema.$schema,
            type: "object",
            patternProperties: { "^(a)\\1$": true },
            additionalProperties: false,
          },
        },
      );
    if (process.env.PIX_FIXTURE_REJECTIONS === "true" && !changed)
      tools.push(
        { name: "SECRET\ninvalid", inputSchema: { type: "object" } },
        {
          name: "bad_dialect",
          inputSchema: { $schema: "https://SECRET.test", type: "object" },
        },
        {
          name: "bad_pattern",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string", pattern: "SECRET[" } },
          },
        },
        {
          name: "long_description",
          description: "SECRET".repeat(3000),
          inputSchema: { type: "object" },
        },
        {
          name: "task_only",
          execution: { taskSupport: "required" },
          inputSchema: { type: "object" },
        },
        ...Array.from({ length: 3 }, (_, index) => ({
          name: `unknown_keyword_${index}`,
          inputSchema: { ...eagleSchema, "SECRET-keyword": true },
        })),
      );
    if (process.env.PIX_FIXTURE_BOOLEAN_SCHEMA !== undefined)
      tools.push({
        name: "boolean",
        inputSchema: {
          type: "object",
          properties: {
            payload: process.env.PIX_FIXTURE_BOOLEAN_SCHEMA === "true",
          },
        },
      });
    return { tools, nextCursor: "page2" };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    calls.push(name);
    const args = request.params.arguments ?? {};
    if (name === "slow")
      await setTimeout(Number(args.delay ?? 100), undefined, {
        signal: extra.signal,
      });
    if (name === "change") {
      if (args.message === "schema") revised = true;
      else changed = true;
      await server.notification({ method: "notifications/tools/list_changed" });
    }
    if (name === "fail")
      return {
        content: [
          { type: "text", text: "Fixture tool failure" },
          ...(["image", "structured-error"].includes(String(args.message))
            ? [{ type: "image", mimeType: "image/png", data: tinyPng }]
            : []),
        ],
        isError: true,
        ...(args.message === "structured-error"
          ? { structuredContent: { error: "failure" } }
          : {}),
      };
    if (name === "large")
      return {
        content: [{ type: "text", text: "Fixture output\n".repeat(4000) }],
      };
    return {
      content: [{ type: "text", text: String(args.message) }],
      structuredContent: { message: args.message },
    };
  });
  return { server, calls };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { server } = fixtureServer();
  await server.connect(new StdioServerTransport());
}
