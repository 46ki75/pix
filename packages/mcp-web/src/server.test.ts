import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

const directories: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
const META_KEY = "cloud.ikuma/mcp-web";

async function connect(
  env: NodeJS.ProcessEnv = { PIX_WEBSEARCH_PROVIDER: "tavily" },
  protocolVersion?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-web-test-"));
  directories.push(directory);
  const server = createWebServer({ env, artifactDirectory: directory });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  if (protocolVersion !== undefined) {
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = async (message, options) =>
      send(
        "method" in message && message.method === "initialize"
          ? { ...message, params: { ...message.params, protocolVersion } }
          : message,
        options,
      );
  }
  const sent = vi.spyOn(serverTransport, "send");
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const initialized = sent.mock.calls
    .map(([message]) => message)
    .find(
      (message) => "result" in message && "protocolVersion" in message.result,
    );
  if (!initialized || !("result" in initialized))
    throw new Error("Missing initialization result");
  const negotiatedVersion = InitializeResultSchema.parse(
    initialized.result,
  ).protocolVersion;
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, server, directory, negotiatedVersion };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return CallToolResultSchema.parse(result)
    .content.filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("combined MCP server", () => {
  it("advertises both tools without making network requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const { client } = await connect();
    expect(client.getServerVersion()).toEqual({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    expect(client.getServerCapabilities()).toMatchObject({
      tools: {},
      resources: {},
    });
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "websearch",
      "webfetch",
    ]);
    expect(listed.tools[0]?.inputSchema).toMatchObject({
      required: ["query"],
      properties: { query: { maxLength: 4_000 } },
      additionalProperties: false,
    });
    expect(listed.tools[1]?.inputSchema).toMatchObject({
      required: ["url"],
      properties: {
        url: { maxLength: 8_192 },
        format: { enum: ["markdown", "text"] },
      },
    });
    expect((await client.listResources()).resources).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("searches using the existing provider adapters, credentials, and formatter", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        results: [
          {
            url: "https://example.com/source",
            title: "Source",
            content: "Excerpt",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const { client } = await connect({
      PIX_WEBSEARCH_PROVIDER: "tavily",
      TAVILY_API_KEY: "test-key",
    });
    const result = await client.callTool({
      name: "websearch",
      arguments: { query: "  TypeScript  " },
    });
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("## [Source](<https://example.com/source>)");
    expect(text(result)).toContain("Excerpt");
    expect(result._meta?.[META_KEY]).toMatchObject({
      provider: "tavily",
      results: [{ title: "Source" }],
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
        body: expect.stringContaining('"query":"TypeScript"'),
      }),
    );
  });

  it("keeps an auto provider for the connection and falls back after a rate limit", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).includes("exa.ai")) {
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "60" },
        });
      }
      const body = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: {
            results: [{ url: "https://example.com", excerpts: ["Result"] }],
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const { client } = await connect({});
    for (const query of ["first", "second"]) {
      const result = await client.callTool({
        name: "websearch",
        arguments: { query },
      });
      expect(result._meta?.[META_KEY]).toMatchObject({ provider: "parallel" });
    }
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://mcp.exa.ai/mcp",
      "https://search.parallel.ai/mcp",
      "https://search.parallel.ai/mcp",
    ]);
  });

  it("fetches Markdown and text with relative links resolved after redirects", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("/start")
        ? new Response(null, {
            status: 302,
            headers: { Location: "/docs/final" },
          })
        : new Response('<h1>Guide</h1><p><a href="next">Next</a></p>', {
            headers: { "Content-Type": "text/html" },
          }),
    );
    vi.stubGlobal("fetch", fetch);
    const { client } = await connect();
    const markdown = await client.callTool({
      name: "webfetch",
      arguments: { url: "https://example.com/start" },
    });
    expect(text(markdown)).toContain("# Guide");
    expect(text(markdown)).toContain("[Next](https://example.com/docs/next)");
    expect(markdown._meta?.[META_KEY]).toMatchObject({
      url: "https://example.com/docs/final",
      truncated: false,
    });
    const plain = await client.callTool({
      name: "webfetch",
      arguments: { url: "https://example.com/docs/final", format: "text" },
    });
    expect(text(plain)).toContain("Next [https://example.com/docs/next]");
  });

  it("makes full truncated output recoverable through MCP resources, not arbitrary file reads", async () => {
    const source =
      "Preview paragraph.\n".repeat(2_000) + "Final section recovered.";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () => new Response(source)),
    );
    const { client, directory } = await connect();
    const result = await client.callTool({
      name: "webfetch",
      arguments: { url: "https://example.com/long" },
    });
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(24 * 1024);
    expect(text(result)).not.toContain("Final section recovered.");
    const link = CallToolResultSchema.parse(result).content.find(
      (content) => content.type === "resource_link",
    );
    if (link?.type !== "resource_link")
      throw new Error("Missing full-output resource link");
    expect(result._meta?.[META_KEY]).toMatchObject({
      truncated: true,
      fullOutputUri: link.uri,
    });
    expect((await client.listResources()).resources).toMatchObject([
      { uri: link.uri },
    ]);
    const recovered = await client.readResource({ uri: link.uri });
    const recoveredContent = recovered.contents[0];
    if (!recoveredContent || !("text" in recoveredContent)) {
      throw new Error("Missing recovered text");
    }
    expect(recoveredContent.text).toContain("Final section recovered.");

    const secret = join(directory, "secret.txt");
    await writeFile(secret, "private data");
    await expect(
      client.readResource({ uri: pathToFileURL(secret).href }),
    ).rejects.toMatchObject({ code: -32602 });
    await rm(new URL(link.uri));
    await expect(client.readResource({ uri: link.uri })).rejects.toThrow(
      "Full output is unavailable",
    );
    expect((await client.listResources()).resources).toEqual([]);
  });

  it.each([
    { requested: "2024-11-05", negotiated: "2024-11-05", links: false },
    { requested: "2025-03-26", negotiated: "2025-03-26", links: false },
    { requested: "2025-06-18", negotiated: "2025-06-18", links: true },
    { requested: "2025-11-25", negotiated: "2025-11-25", links: true },
    {
      requested: "unsupported",
      negotiated: LATEST_PROTOCOL_VERSION,
      links: true,
    },
  ])(
    "preserves artifact recovery when negotiating $requested",
    async ({ requested, negotiated, links }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof globalThis.fetch>(
          async () =>
            new Response(
              "Paragraph 🌐.\n".repeat(3_000) + "Recovered final section.",
            ),
        ),
      );
      const { client, server, negotiatedVersion } = await connect(
        {},
        requested,
      );
      expect(negotiatedVersion).toBe(negotiated);
      expect(server.getClientVersion()).toEqual({
        name: "test-client",
        version: "1.0.0",
      });
      expect(server.getClientCapabilities()).toEqual({});
      const result = await client.callTool({
        name: "webfetch",
        arguments: { url: "https://example.com/long" },
      });
      const content = CallToolResultSchema.parse(result).content;
      expect(content.map((item) => item.type)).toEqual(
        links ? ["text", "resource_link"] : ["text"],
      );
      const resources = (await client.listResources()).resources;
      const uri = resources[0]?.uri;
      if (!uri) throw new Error("Missing recoverable resource");
      if (!links) {
        expect(text(result)).toContain(uri);
        expect(text(result)).toContain("resources/read");
      }
      expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(24 * 1024);
      expect(text(result)).not.toContain("�");
      expect(result._meta?.[META_KEY]).toMatchObject({
        truncated: true,
        fullOutputUri: uri,
      });
      const recovered = (await client.readResource({ uri })).contents[0];
      if (!recovered || !("text" in recovered))
        throw new Error("Missing recovered text");
      expect(recovered.text).toContain("Recovered final section.");
    },
  );

  it("bounds the resource catalog to the most recent 64 outputs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(
        async () => new Response("x".repeat(25_000)),
      ),
    );
    const { client } = await connect();
    let firstUri: string | undefined;
    for (let index = 0; index < 65; index++) {
      const result = await client.callTool({
        name: "webfetch",
        arguments: { url: "https://example.com/long" },
      });
      const link = CallToolResultSchema.parse(result).content.find(
        (content) => content.type === "resource_link",
      );
      if (index === 0 && link?.type === "resource_link") firstUri = link.uri;
    }
    expect((await client.listResources()).resources).toHaveLength(64);
    if (!firstUri) throw new Error("Missing first resource URI");
    await expect(client.readResource({ uri: firstUri })).rejects.toThrow(
      "Unknown full-output resource",
    );
  });

  it.each([
    ["websearch", {}],
    ["websearch", { query: "" }],
    ["websearch", { query: "   " }],
    ["websearch", { query: 123 }],
    ["websearch", { query: "q".repeat(4_001) }],
    ["websearch", { query: "query", unexpected: true }],
    ["webfetch", {}],
    ["webfetch", { url: 123 }],
    ["webfetch", { url: "u".repeat(8_193) }],
    ["webfetch", { url: "file:///etc/passwd" }],
    ["webfetch", { url: "https://user:password@example.com" }],
    ["webfetch", { url: "https://example.com", format: "html" }],
    ["webfetch", { url: "https://example.com", format: null }],
    ["webfetch", { url: "https://example.com", unexpected: true }],
  ])(
    "returns an actionable tool error for invalid %s arguments %j",
    async (name, args) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      vi.stubGlobal("fetch", fetch);
      const { client } = await connect();
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(text(result)).not.toBe("");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("reports unknown tools as protocol errors", async () => {
    const { client } = await connect();
    await expect(
      client.callTool({ name: "unknown", arguments: {} }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it.each([{ args: null }, { args: [] }, { args: "text" }])(
    "rejects malformed argument objects $args at the protocol boundary",
    async ({ args }) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      vi.stubGlobal("fetch", fetch);
      const { client } = await connect();
      await expect(
        client.request(
          {
            method: "tools/call",
            params: { name: "webfetch", arguments: args },
          },
          CallToolResultSchema,
        ),
      ).rejects.toBeInstanceOf(McpError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("reports invalid provider configuration without network access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const { client } = await connect({ PIX_WEBSEARCH_PROVIDER: "invalid" });
    const result = await client.callTool({
      name: "websearch",
      arguments: { query: "query" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("PIX_WEBSEARCH_PROVIDER must be");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["webfetch", "websearch"])(
    "does not expose raw network errors from %s",
    async (name) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof globalThis.fetch>(async () => {
          throw new Error("secret-token");
        }),
      );
      const { client } = await connect();
      const result = await client.callTool({
        name,
        arguments:
          name === "webfetch"
            ? { url: "https://example.com" }
            : { query: "query" },
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("network request failed");
      expect(JSON.stringify(result)).not.toContain("secret-token");
    },
  );

  it.each([
    ["webfetch", "cancellation"],
    ["websearch", "cancellation"],
    ["webfetch", "connection closure"],
    ["websearch", "connection closure"],
  ])("stops %s HTTP requests on MCP %s", async (name, reason) => {
    let started!: () => void;
    let cancelled!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => {
              cancelled();
              reject(signal.reason);
            },
            { once: true },
          );
          started();
        });
      }),
    );
    const { client } = await connect();
    const controller = new AbortController();
    const pending = client.callTool(
      {
        name,
        arguments:
          name === "webfetch"
            ? { url: "https://example.com" }
            : { query: "query" },
      },
      undefined,
      { signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toBeDefined();
    await ready;
    if (reason === "cancellation") controller.abort();
    else await client.close();
    await rejected;
    await aborted;
  });

  it("keeps the protocol version aligned with the package manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(SERVER_VERSION).toBe(manifest.version);
  });
});
