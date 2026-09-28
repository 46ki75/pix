import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  EmptyResultSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Prompt,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, test } from "vitest";
import { Connection } from "./client.ts";
import type { ServerConfig } from "./config.ts";
import { eagleSchema, fixtureServer, legacySchema } from "./fixtures/server.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function httpFixture(
  options: {
    reject?: boolean;
    redirect?: boolean;
    badSchema?: boolean;
    badPagination?: boolean;
    paginatedSchema?: boolean;
    emptyCursor?: boolean;
    hangInitialized?: boolean;
    noNotifications?: boolean;
    timeout?: number;
    startupTimeoutMs?: number;
    catalogTimeoutMs?: number;
    jsonResponse?: boolean;
    initializeDelay?: number;
    catalogDelay?: number;
    resourceCatalogDelay?: number;
    stalledBody?: "application/json" | "text/event-stream";
    oversizedReadResponse?: boolean;
    notificationContentType?: string;
    legacyOutput?: boolean;
    draft07Output?: boolean;
    onToolsChanged?: (tools: Tool[], connection: Connection) => void;
    onPromptsChanged?: (prompts: Prompt[], connection: Connection) => void;
    onResourcesChanged?: (
      resources: Resource[],
      templates: ResourceTemplate[],
      connection: Connection,
    ) => void;
  } = {},
) {
  const { server, calls, promptCalls, resourceCalls } = fixtureServer();
  if (options.badSchema || options.paginatedSchema)
    server.setRequestHandler(ListToolsRequestSchema, (request) => {
      if (request.params?.cursor === "second") return { tools: [] };
      return {
        tools: [
          {
            name: "echo",
            inputSchema: { type: "object" },
            outputSchema: { type: "object", required: ["missing"] },
          },
        ],
        ...(options.paginatedSchema ? { nextCursor: "second" } : {}),
      };
    });
  if (options.badPagination)
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [],
      nextCursor: "repeat",
    }));
  if (options.emptyCursor)
    server.setRequestHandler(ListToolsRequestSchema, (request) =>
      request.params?.cursor === ""
        ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
        : { tools: [], nextCursor: "" },
    );
  if (options.legacyOutput || options.draft07Output)
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "echo",
          inputSchema: { type: "object" },
          outputSchema: options.draft07Output ? eagleSchema : legacySchema,
        },
      ],
    }));
  let deleted = false;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: options.jsonResponse ?? false,
    onsessionclosed: () => {
      deleted = true;
    },
  });
  await server.connect(transport as Transport);
  const methods: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const cancelled: unknown[] = [];
  let closedCalls = 0;
  let notificationResponse: ServerResponse | undefined;
  const http = createServer((request, response) => {
    void (async () => {
      authorizations.push(request.headers.authorization);
      if (options.reject) {
        response.writeHead(401);
        response.end("SECRET response body");
        return;
      }
      if (options.redirect) {
        response.writeHead(307, { Location: "/redirected?secret=SECRET" });
        response.end();
        return;
      }
      if (request.method === "GET") {
        if (options.noNotifications) {
          response.writeHead(405).end();
          return;
        }
        notificationResponse = response;
        if (options.notificationContentType) {
          response.writeHead(200, {
            "Content-Type": options.notificationContentType,
          });
          response.write(": fixture ready\n\n");
          return;
        }
      }
      let body: unknown;
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        body = JSON.parse(Buffer.concat(chunks).toString());
        const message = body as {
          method?: string;
          params?: { requestId?: unknown };
        };
        methods.push(message.method ?? "response");
        if (message.method === "notifications/cancelled")
          cancelled.push(message.params?.requestId);
        if (message.method === "initialize" && options.initializeDelay)
          await setTimeout(options.initializeDelay);
        if (message.method === "tools/list" && options.catalogDelay)
          await setTimeout(options.catalogDelay);
        if (message.method === "resources/list" && options.resourceCatalogDelay)
          await setTimeout(options.resourceCatalogDelay);
        if (message.method === "tools/call") {
          response.on("close", () => closedCalls++);
          if (options.stalledBody) {
            response.writeHead(200, { "Content-Type": options.stalledBody });
            response.write(
              options.stalledBody === "application/json"
                ? '{"jsonrpc":'
                : ": heartbeat\n\n",
            );
            return;
          }
        }
        if (
          message.method === "resources/read" &&
          options.oversizedReadResponse
        ) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.write(
            `{"jsonrpc":"2.0","id":${JSON.stringify((body as { id: unknown }).id)},"result":{"contents":[{"uri":"fixture://large","text":"`,
          );
          const chunk = "x".repeat(1024 * 1024);
          for (let index = 0; index < 17; index++) response.write(chunk);
          response.end('"}]}}');
          return;
        }
        if (
          options.hangInitialized &&
          (body as { method: string }).method === "notifications/initialized"
        )
          return;
      }
      await transport.handleRequest(request, response, body);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const config: ServerConfig = {
    name: "http",
    type: "http",
    description: "Fixture",
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    headers: { Authorization: "Bearer fixture-token" },
    timeout: options.timeout ?? 1000,
    startupTimeoutMs: options.startupTimeoutMs ?? 1000,
    catalogTimeoutMs: options.catalogTimeoutMs ?? 1000,
  };
  const catalogs: Tool[][] = [];
  const promptCatalogs: Prompt[][] = [];
  const resourceCatalogs: {
    resources: Resource[];
    templates: ResourceTemplate[];
  }[] = [];
  let connection: Connection;
  connection = new Connection(
    config,
    (tools) => {
      catalogs.push(tools);
      options.onToolsChanged?.(tools, connection);
    },
    (prompts) => {
      promptCatalogs.push(prompts);
      options.onPromptsChanged?.(prompts, connection);
    },
    (resources, templates) => {
      resourceCatalogs.push({ resources, templates });
      options.onResourcesChanged?.(resources, templates, connection);
    },
  );
  cleanups.push(() => connection.close());
  return {
    connection,
    config,
    methods,
    authorizations,
    catalogs,
    promptCatalogs,
    resourceCatalogs,
    calls,
    promptCalls,
    resourceCalls,
    cancelled,
    closedCalls: () => closedCalls,
    server,
    wasDeleted: () => deleted,
    hasNotificationStream: () => notificationResponse !== undefined,
    dropNotifications: (abrupt: boolean) =>
      abrupt ? notificationResponse?.destroy() : notificationResponse?.end(),
  };
}

test("HTTP shares initialization, follows pagination, propagates headers and terminates its session", async () => {
  const fixture = await httpFixture();
  const { connection, methods, authorizations, catalogs } = fixture;
  expect(connection.start()).toBe(connection.start());
  await connection.start();
  expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
  expect(methods.filter((method) => method === "tools/list")).toHaveLength(2);
  expect(methods.filter((method) => method === "prompts/list")).toHaveLength(2);
  expect(methods.filter((method) => method === "resources/list")).toHaveLength(
    2,
  );
  expect(
    methods.filter((method) => method === "resources/templates/list"),
  ).toHaveLength(2);
  expect(catalogs.at(-1)).toHaveLength(5);
  expect(fixture.promptCatalogs.at(-1)).toHaveLength(2);
  expect(fixture.resourceCatalogs.at(-1)).toMatchObject({
    resources: { length: 5 },
    templates: { length: 2 },
  });
  expect(
    authorizations.every((value) => value === "Bearer fixture-token"),
  ).toBe(true);
  expect(
    (await connection.call("echo", { message: "HTTP" })).structuredContent,
  ).toEqual({ message: "HTTP" });
  expect(connection.close()).toBe(connection.close());
  await connection.close();
  expect(fixture.wasDeleted()).toBe(true);
});

test("the entire HTTP initialization handshake has a deadline", async () => {
  const { connection } = await httpFixture({
    hangInitialized: true,
    startupTimeoutMs: 100,
  });
  const outcome = await Promise.race([
    connection.start().then(
      () => "connected",
      () => "rejected",
    ),
    setTimeout(500, "hung"),
  ]);
  expect(outcome).toBe("rejected");
});

test.each([false, true])(
  "losing an established HTTP notification stream withdraws stale tools (abrupt=%s)",
  async (abrupt) => {
    const fixture = await httpFixture();
    await fixture.connection.start();
    await expect.poll(fixture.hasNotificationStream).toBe(true);
    fixture.dropNotifications(abrupt);
    await expect
      .poll(() => fixture.catalogs.at(-1), { timeout: 500 })
      .toEqual([]);
    expect(fixture.promptCatalogs.at(-1)).toEqual([]);
    expect(fixture.resourceCatalogs.at(-1)).toEqual({
      resources: [],
      templates: [],
    });
    expect(fixture.connection.status).not.toBe("Connected");
    await expect(
      fixture.connection.call("echo", { message: "must not execute" }),
    ).rejects.toThrow();
    expect(fixture.calls).toEqual([]);
  },
);

test("HTTP servers may decline a standalone notification stream with 405", async () => {
  const { connection } = await httpFixture({ noNotifications: true });
  await connection.start();
  expect(
    (await connection.call("echo", { message: "usable" })).content[0],
  ).toMatchObject({ text: "usable" });
});

test("notification MIME essence is case-insensitive", async () => {
  const { connection } = await httpFixture({
    notificationContentType: "Text/Event-Stream; charset=utf-8",
  });
  await connection.start();
  expect(
    (await connection.call("echo", { message: "usable" })).content[0],
  ).toMatchObject({ text: "usable" });
});

test("an unrelated notification MIME type containing the SSE substring is rejected", async () => {
  const fixture = await httpFixture({
    notificationContentType: 'text/plain; note="text/event-stream"',
  });
  await fixture.connection.start().catch(() => {});
  await expect.poll(() => fixture.connection.status).not.toBe("Connected");
  await expect(
    fixture.connection.call("echo", { message: "must not execute" }),
  ).rejects.toThrow();
  expect(fixture.calls).toEqual([]);
});

test("compatible draft-07 output schemas preserve response validation", async () => {
  const { connection, calls } = await httpFixture({ draft07Output: true });
  await connection.start();
  expect(connection.status).toBe("Connected");
  expect(calls).toEqual([]);
  expect(
    (await connection.call("echo", { message: "valid" })).structuredContent,
  ).toEqual({ message: "valid" });
  await expect(connection.call("echo", { message: "x" })).rejects.toThrow(
    "call failed",
  );
  expect(calls).toEqual(["echo", "echo"]);
});

test("unrepresentable legacy output schemas fail discovery without running tools", async () => {
  const { connection, calls } = await httpFixture({ legacyOutput: true });
  await expect(connection.start()).rejects.toThrow("discovery failed");
  expect(calls).toEqual([]);
});

test.each([
  { properties: { value: { const: [] } } },
  { properties: { value: { enum: [[]] } } },
  { patternProperties: { "^(a)\\1$": true }, additionalProperties: false },
])(
  "unsafe draft-07 output schemas fail discovery without calls (%j)",
  async (fragment) => {
    const { server, connection, calls } = await httpFixture();
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "echo",
          inputSchema: { type: "object" },
          outputSchema: {
            $schema: eagleSchema.$schema,
            type: "object",
            ...fragment,
          },
        },
      ],
    }));
    await expect(connection.start()).rejects.toThrow("discovery failed");
    expect(calls).toEqual([]);
  },
);

test("HTTP notifications refresh the catalog", async () => {
  const { connection, catalogs } = await httpFixture();
  await connection.start();
  await connection.call("change", { message: "update" });
  await expect.poll(() => catalogs.at(-1)?.[0]?.name).toBe("echo_v2");
});

test.each(["tools", "prompts", "resources"] as const)(
  "%s refreshes do not lose dirty state while their promise settles",
  async (feature) => {
    let armed = false;
    let queued = false;
    const onChanged = (
      _items: Tool[] | Prompt[] | Resource[],
      connection: Connection,
    ) => {
      if (!armed || queued) return;
      queued = true;
      // Reach the gap after the refresh loop settles but before the public
      // refresh promise's cleanup reaction runs.
      queueMicrotask(() =>
        queueMicrotask(() =>
          queueMicrotask(() => {
            const refresh =
              feature === "tools"
                ? connection.refresh()
                : feature === "prompts"
                  ? connection.refreshPrompts()
                  : connection.refreshResources();
            void refresh.catch(() => {});
          }),
        ),
      );
    };
    const fixture = await httpFixture(
      feature === "tools"
        ? { onToolsChanged: onChanged }
        : feature === "prompts"
          ? { onPromptsChanged: onChanged }
          : {
              onResourcesChanged: (resources, _templates, connection) =>
                onChanged(resources, connection),
            },
    );
    await fixture.connection.start();
    const method =
      feature === "tools"
        ? "tools/list"
        : feature === "prompts"
          ? "prompts/list"
          : "resources/list";
    const before = fixture.methods.filter((item) => item === method).length;
    armed = true;
    await (feature === "tools"
      ? fixture.connection.refresh()
      : feature === "prompts"
        ? fixture.connection.refreshPrompts()
        : fixture.connection.refreshResources());
    expect(fixture.methods.filter((item) => item === method)).toHaveLength(
      before + 4,
    );
  },
);

test("discovers paginated prompts and gets one with string arguments", async () => {
  const fixture = await httpFixture();
  await fixture.connection.start();
  expect(fixture.promptCatalogs.at(-1)?.map((prompt) => prompt.name)).toEqual([
    "review",
    "conversation",
  ]);
  await expect(
    fixture.connection.getPrompt("review", {
      topic: "deadlines",
      tone: "concise",
    }),
  ).resolves.toMatchObject({
    messages: [
      {
        role: "user",
        content: { text: "Review deadlines in a concise tone." },
      },
    ],
  });
  expect(fixture.promptCalls).toEqual(["review"]);
  await expect(
    fixture.connection.getPrompt("missing", undefined),
  ).rejects.toThrow("unavailable");
  expect(fixture.promptCalls).toEqual(["review"]);
});

test("discovers paginated resources and templates and reads a resource", async () => {
  const fixture = await httpFixture();
  await fixture.connection.start();
  expect(
    fixture.resourceCatalogs.at(-1)?.resources.map((resource) => resource.uri),
  ).toEqual([
    "fixture://notes",
    "fixture://image",
    "fixture://binary",
    "fixture://collection",
    "fixture://change",
  ]);
  expect(
    fixture.resourceCatalogs
      .at(-1)
      ?.templates.map((template) => template.uriTemplate),
  ).toEqual(["fixture://dynamic/text/{id}", "fixture://dynamic/blob/{id}"]);
  await expect(
    fixture.connection.readResource("fixture://notes"),
  ).resolves.toMatchObject({
    contents: [{ uri: "fixture://notes", text: "Fixture notes" }],
  });
  expect(fixture.resourceCalls).toEqual(["fixture://notes"]);
  await expect(
    fixture.connection.readResource("fixture://unsafe\nuri"),
  ).rejects.toThrow("Invalid MCP resource URI");
  expect(fixture.resourceCalls).toEqual(["fixture://notes"]);
});

test("resource catalogs discard private metadata and untrusted icons", async () => {
  const fixture = await httpFixture();
  fixture.server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      {
        uri: "fixture://safe",
        name: "safe",
        icons: [{ src: "https://user:secret@example.test/icon.png" }],
        _meta: { secret: "resource metadata" },
      },
    ],
  }));
  fixture.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [
      {
        uriTemplate: "fixture://safe/{id}",
        name: "safe template",
        icons: [{ src: "https://user:secret@example.test/icon.png" }],
        _meta: { secret: "template metadata" },
      },
    ],
  }));

  await fixture.connection.start();

  expect(fixture.resourceCatalogs.at(-1)).toEqual({
    resources: [{ uri: "fixture://safe", name: "safe" }],
    templates: [{ uriTemplate: "fixture://safe/{id}", name: "safe template" }],
  });
});

test("resource list-change notifications atomically replace resources and templates", async () => {
  const fixture = await httpFixture();
  let revision = "first";
  fixture.server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [{ uri: `fixture://${revision}`, name: revision }],
  }));
  fixture.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [
      { uriTemplate: `fixture://${revision}/{id}`, name: revision },
    ],
  }));
  await fixture.connection.start();
  expect(fixture.resourceCatalogs.at(-1)).toMatchObject({
    resources: [{ uri: "fixture://first" }],
    templates: [{ uriTemplate: "fixture://first/{id}" }],
  });
  revision = "second";
  await fixture.server.notification({
    method: "notifications/resources/list_changed",
  });
  await expect
    .poll(() => fixture.resourceCatalogs.at(-1)?.resources[0]?.uri)
    .toBe("fixture://second");
  expect(fixture.resourceCatalogs.at(-1)?.templates[0]?.uriTemplate).toBe(
    "fixture://second/{id}",
  );
});

test("resource refreshes invalidate the previous snapshot before awaiting the server", async () => {
  const fixture = await httpFixture({ resourceCatalogDelay: 50 });
  await fixture.connection.start();
  expect(fixture.resourceCatalogs.at(-1)?.resources.length).toBeGreaterThan(0);

  const refresh = fixture.connection.refreshResources();
  expect(fixture.connection.resourceStatus).toBe("Loading");
  expect(fixture.resourceCatalogs.at(-1)).toEqual({
    resources: [],
    templates: [],
  });
  await refresh;
  expect(fixture.connection.resourceStatus).toBe("Available");
  expect(fixture.resourceCatalogs.at(-1)?.resources.length).toBeGreaterThan(0);
});

test("a list-change between resource endpoints never publishes a mixed snapshot", async () => {
  const fixture = await httpFixture();
  let revision = "first";
  let notified = false;
  fixture.server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [{ uri: `fixture://${revision}`, name: revision }],
  }));
  fixture.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async () => {
      if (!notified) {
        notified = true;
        revision = "second";
        await fixture.server.notification({
          method: "notifications/resources/list_changed",
        });
        await setTimeout(20);
      }
      return {
        resourceTemplates: [
          { uriTemplate: `fixture://${revision}/{id}`, name: revision },
        ],
      };
    },
  );

  await fixture.connection.start();

  expect(fixture.resourceCatalogs).not.toContainEqual({
    resources: [{ uri: "fixture://first", name: "first" }],
    templates: [{ uriTemplate: "fixture://second/{id}", name: "second" }],
  });
  expect(fixture.resourceCatalogs.at(-1)).toEqual({
    resources: [{ uri: "fixture://second", name: "second" }],
    templates: [{ uriTemplate: "fixture://second/{id}", name: "second" }],
  });
});

test.each([
  ["request", undefined],
  ["unsafe URI", "fixture://unsafe\u202Ename"],
] as const)(
  "resource discovery %s failures leave tools and prompts usable",
  async (_failure, invalidUri) => {
    const fixture = await httpFixture();
    fixture.server.setRequestHandler(ListResourcesRequestSchema, () => {
      if (invalidUri === undefined)
        throw new Error("SECRET resource discovery error");
      return { resources: [{ uri: invalidUri, name: "unsafe" }] };
    });
    await expect(fixture.connection.start()).rejects.toThrow(
      "discovery failed",
    );
    expect(fixture.connection.resourceStatus).toContain("failed");
    expect(fixture.resourceCatalogs.at(-1)).toEqual({
      resources: [],
      templates: [],
    });
    expect(
      (await fixture.connection.call("echo", { message: "still usable" }))
        .content[0],
    ).toMatchObject({ text: "still usable" });
    await expect(
      fixture.connection.getPrompt("review", { topic: "healthy prompt" }),
    ).resolves.toMatchObject({
      messages: [{ content: { text: "Review healthy prompt." } }],
    });
  },
);

test.each(["resources", "templates"] as const)(
  "repeated %s pagination cursors fail only resource discovery",
  async (endpoint) => {
    const fixture = await httpFixture();
    if (endpoint === "resources")
      fixture.server.setRequestHandler(ListResourcesRequestSchema, () => ({
        resources: [],
        nextCursor: "repeat",
      }));
    else
      fixture.server.setRequestHandler(
        ListResourceTemplatesRequestSchema,
        () => ({ resourceTemplates: [], nextCursor: "repeat" }),
      );

    await expect(fixture.connection.start()).rejects.toThrow(
      "discovery failed",
    );
    const method =
      endpoint === "resources" ? "resources/list" : "resources/templates/list";
    expect(fixture.methods.filter((value) => value === method)).toHaveLength(2);
    expect(fixture.resourceCatalogs.at(-1)).toEqual({
      resources: [],
      templates: [],
    });
    expect(
      (await fixture.connection.call("echo", { message: "still usable" }))
        .content[0],
    ).toMatchObject({ text: "still usable" });
  },
);

test.each(["resources", "templates"] as const)(
  "duplicate %s identities fail resource discovery",
  async (endpoint) => {
    const fixture = await httpFixture();
    if (endpoint === "resources")
      fixture.server.setRequestHandler(ListResourcesRequestSchema, () => ({
        resources: [
          { uri: "fixture://duplicate", name: "one" },
          { uri: "fixture://duplicate", name: "two" },
        ],
      }));
    else
      fixture.server.setRequestHandler(
        ListResourceTemplatesRequestSchema,
        () => ({
          resourceTemplates: [
            { uriTemplate: "fixture://duplicate/{id}", name: "one" },
            { uriTemplate: "fixture://duplicate/{id}", name: "two" },
          ],
        }),
      );

    await expect(fixture.connection.start()).rejects.toThrow(
      "discovery failed",
    );
    expect(fixture.resourceCatalogs.at(-1)).toEqual({
      resources: [],
      templates: [],
    });
  },
);

test("direct resources and templates share one catalog entry limit", async () => {
  const fixture = await httpFixture();
  fixture.server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: Array.from({ length: 600 }, (_, index) => ({
      uri: `fixture://resource/${index}`,
      name: `resource-${index}`,
    })),
  }));
  fixture.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: Array.from({ length: 401 }, (_, index) => ({
      uriTemplate: `fixture://template/${index}/{id}`,
      name: `template-${index}`,
    })),
  }));

  await expect(fixture.connection.start()).rejects.toThrow("discovery failed");
  expect(fixture.resourceCatalogs.at(-1)).toEqual({
    resources: [],
    templates: [],
  });
});

test("resource template failures withdraw the entire resource snapshot", async () => {
  const fixture = await httpFixture();
  fixture.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [
      { uriTemplate: "fixture:///{bad-name}", name: "invalid" },
    ],
  }));
  await expect(fixture.connection.start()).rejects.toThrow("discovery failed");
  expect(fixture.resourceCatalogs.at(-1)).toEqual({
    resources: [],
    templates: [],
  });
  await expect(
    fixture.connection.readResource("fixture://notes"),
  ).rejects.toThrow("unavailable");
  expect(fixture.resourceCalls).toEqual([]);
});

test("rejects oversized HTTP resource responses while streaming", async () => {
  const fixture = await httpFixture({ oversizedReadResponse: true });
  await fixture.connection.start();
  await expect(
    fixture.connection.readResource("fixture://large"),
  ).rejects.toThrow("failed or timed out");
  await expect(
    fixture.connection.call("echo", { message: "still usable" }),
  ).resolves.toMatchObject({ content: [{ text: "still usable" }] });
});

test("cancelling a resource read leaves concurrent requests usable", async () => {
  const fixture = await httpFixture({ timeout: 2000 });
  fixture.server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request, extra) => {
      fixture.resourceCalls.push(request.params.uri);
      await setTimeout(1000, undefined, { signal: extra.signal });
      return { contents: [{ uri: request.params.uri, text: "late" }] };
    },
  );
  await fixture.connection.start();
  const controller = new AbortController();
  const read = fixture.connection.readResource(
    "fixture://notes",
    controller.signal,
  );
  const sibling = fixture.connection.call("echo", { message: "usable" });
  await expect.poll(() => fixture.resourceCalls.length).toBe(1);
  controller.abort();
  await expect(read).rejects.toThrow();
  await expect(sibling).resolves.toMatchObject({
    content: [{ text: "usable" }],
  });
  await expect.poll(() => fixture.cancelled.length).toBe(1);
  await expect(
    fixture.connection.call("echo", { message: "still usable" }),
  ).resolves.toMatchObject({ content: [{ text: "still usable" }] });
});

test("resource reads use the invocation deadline without disabling other features", async () => {
  const fixture = await httpFixture({ timeout: 100 });
  fixture.server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request, extra) => {
      fixture.resourceCalls.push(request.params.uri);
      await setTimeout(1000, undefined, { signal: extra.signal });
      return { contents: [{ uri: request.params.uri, text: "late" }] };
    },
  );
  await fixture.connection.start();
  await expect(
    fixture.connection.readResource("fixture://notes"),
  ).rejects.toThrow("failed or timed out");
  expect(fixture.resourceCalls).toEqual(["fixture://notes"]);
  expect(
    (await fixture.connection.call("echo", { message: "still usable" }))
      .content[0],
  ).toMatchObject({ text: "still usable" });
});

test("prompt list-change notifications replace the prompt catalog", async () => {
  const fixture = await httpFixture();
  let name = "first";
  fixture.server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [{ name }],
  }));
  await fixture.connection.start();
  expect(fixture.promptCatalogs.at(-1)?.[0]?.name).toBe("first");
  name = "second";
  await fixture.server.notification({
    method: "notifications/prompts/list_changed",
  });
  await expect
    .poll(() => fixture.promptCatalogs.at(-1)?.[0]?.name)
    .toBe("second");
});

test.each([
  ["request", undefined],
  ["line-separator metadata", "SECRET\u2028invalid"],
  ["bidi metadata", "safe\u202Espoofed"],
] as const)(
  "prompt discovery %s failures leave tools and resources usable",
  async (_failure, invalidName) => {
    const fixture = await httpFixture();
    fixture.server.setRequestHandler(ListPromptsRequestSchema, () => {
      if (invalidName === undefined)
        throw new Error("SECRET prompt discovery error");
      return { prompts: [{ name: invalidName }] };
    });
    await expect(fixture.connection.start()).rejects.toThrow(
      "discovery failed",
    );
    expect(fixture.connection.promptStatus).toContain("failed");
    expect(fixture.promptCatalogs.at(-1)).toEqual([]);
    expect(
      (await fixture.connection.call("echo", { message: "still usable" }))
        .content[0],
    ).toMatchObject({ text: "still usable" });
    await expect(
      fixture.connection.readResource("fixture://notes"),
    ).resolves.toMatchObject({ contents: [{ text: "Fixture notes" }] });
  },
);

test("tool discovery failures leave prompts and resources usable", async () => {
  const fixture = await httpFixture({ badPagination: true });
  await expect(fixture.connection.start()).rejects.toThrow("discovery failed");
  expect(fixture.connection.toolStatus).toContain("failed");
  await expect(
    fixture.connection.getPrompt("review", { topic: "healthy prompt" }),
  ).resolves.toMatchObject({
    messages: [{ content: { text: "Review healthy prompt." }, role: "user" }],
  });
  await expect(
    fixture.connection.readResource("fixture://notes"),
  ).resolves.toMatchObject({
    contents: [{ text: "Fixture notes" }],
  });
});

test("prompt requests use the invocation deadline without disabling tools", async () => {
  const fixture = await httpFixture({ timeout: 100 });
  fixture.server.setRequestHandler(
    GetPromptRequestSchema,
    async (_request, extra) => {
      await setTimeout(1000, undefined, { signal: extra.signal });
      return {
        messages: [{ role: "user", content: { type: "text", text: "late" } }],
      };
    },
  );
  await fixture.connection.start();
  await expect(
    fixture.connection.getPrompt("review", { topic: "timeout" }),
  ).rejects.toThrow("failed or timed out");
  expect(
    (await fixture.connection.call("echo", { message: "still usable" }))
      .content[0],
  ).toMatchObject({ text: "still usable" });
});

test("request timeouts never retry a possibly mutating call", async () => {
  const { connection, config, calls } = await httpFixture();
  await connection.start();
  config.timeout = 100;
  await expect(
    connection.call("slow", { message: "x", delay: 1000 }),
  ).rejects.toThrow("may already have taken effect");
  expect(calls).toEqual(["slow"]);
  expect(
    (await connection.call("echo", { message: "still usable" })).content[0],
  ).toMatchObject({ text: "still usable" });
});

test.each([{ reject: true }, { redirect: true }])(
  "authentication and redirects fail without leaking credentials or following redirects",
  async (options) => {
    const { connection, authorizations } = await httpFixture(options);
    await expect(connection.start()).rejects.toThrow(
      /^MCP server http: connection failed\.$/,
    );
    expect(authorizations).toHaveLength(1);
  },
);

test("repeated pagination cursors fail discovery rather than looping", async () => {
  const { connection, methods, catalogs } = await httpFixture({
    badPagination: true,
  });
  await expect(connection.start()).rejects.toThrow("discovery failed");
  expect(methods.filter((method) => method === "tools/list")).toHaveLength(2);
  expect(catalogs.at(-1)).toEqual([]);
});

test("empty but defined pagination cursors are forwarded unchanged", async () => {
  const { connection, catalogs } = await httpFixture({ emptyCursor: true });
  await connection.start();
  expect(catalogs.at(-1)?.[0]?.name).toBe("echo");
});

test("output schemas from earlier catalog pages remain enforced", async () => {
  const { connection } = await httpFixture({ paginatedSchema: true });
  await connection.start();
  await expect(connection.call("echo", { message: "x" })).rejects.toThrow(
    "call failed",
  );
});

test("in-flight results use the output schema captured before catalog refresh", async () => {
  const { connection, server, catalogs, calls } = await httpFixture();
  let outputSchema: Tool["outputSchema"] = {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  };
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: "echo", inputSchema: { type: "object" }, outputSchema }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push(request.params.name);
    enter();
    await released;
    return {
      content: [{ type: "text", text: "old" }],
      structuredContent: { message: "old" },
    };
  });
  await connection.start();
  const result = connection.call("echo", {}).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    await entered;
    outputSchema = {
      type: "object",
      properties: { version: { type: "number" } },
      required: ["version"],
    };
    await server.notification({ method: "notifications/tools/list_changed" });
    await expect
      .poll(() => catalogs.at(-1)?.[0]?.outputSchema)
      .toEqual(outputSchema);
  } finally {
    release();
  }
  expect(await result).toMatchObject({
    value: { structuredContent: { message: "old" } },
  });
  expect(calls).toEqual(["echo"]);
});

test("structured MCP errors are exempt from success output schemas", async () => {
  const { connection, server, calls } = await httpFixture();
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "echo",
        inputSchema: { type: "object" },
        outputSchema: { type: "object", required: ["message"] },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    calls.push(request.params.name);
    return {
      isError: true,
      content: [{ type: "text", text: "Actionable failure" }],
      structuredContent: { error: "failure" },
    };
  });
  await connection.start();
  await expect(connection.call("echo", {})).resolves.toMatchObject({
    isError: true,
    content: [{ type: "text", text: "Actionable failure" }],
    structuredContent: { error: "failure" },
  });
  expect(calls).toEqual(["echo"]);
});

test.each([true, false])(
  "boolean input property schemas do not hide healthy tools (%s)",
  async (allowed) => {
    const { connection, server, catalogs } = await httpFixture();
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        { name: "echo", inputSchema: { type: "object" } },
        {
          name: "boolean",
          inputSchema: { type: "object", properties: { payload: allowed } },
        },
      ],
    }));
    await connection.start();
    expect(catalogs.at(-1)).toHaveLength(2);
    expect(catalogs.at(-1)?.[1]?.inputSchema.properties).toEqual({
      payload: allowed,
    });
    expect(
      (await connection.call("echo", { message: "healthy" })).content[0],
    ).toMatchObject({ text: "healthy" });
  },
);

test.each([true, false])(
  "boolean output property schemas retain their validation semantics (%s)",
  async (allowed) => {
    const { connection, server } = await httpFixture();
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "echo",
          inputSchema: { type: "object" },
          outputSchema: { type: "object", properties: { message: allowed } },
        },
      ],
    }));
    await connection.start();
    if (allowed)
      await expect(
        connection.call("echo", { message: "valid" }),
      ).resolves.toMatchObject({ structuredContent: { message: "valid" } });
    else
      await expect(
        connection.call("echo", { message: "invalid" }),
      ).rejects.toThrow("call failed");
  },
);

test("output schema validation remains enabled", async () => {
  const { connection, calls } = await httpFixture({ badSchema: true });
  await connection.start();
  await expect(connection.call("echo", { message: "x" })).rejects.toThrow(
    "call failed",
  );
  expect(calls).toHaveLength(1);
});

test.each([false, true])(
  "long HTTP calls bypass ambient idle limits without changing host routing (JSON=%s)",
  async (jsonResponse) => {
    const previous = getGlobalDispatcher();
    const agent = new Agent({ headersTimeout: 50, bodyTimeout: 50 });
    const requests: {
      headersTimeout?: number | null;
      bodyTimeout?: number | null;
    }[] = [];
    const routed = agent.compose((dispatch) => (options, handler) => {
      requests.push(options);
      return dispatch(options, handler);
    });
    setGlobalDispatcher(routed);
    cleanups.push(async () => {
      setGlobalDispatcher(previous);
      await agent.destroy();
    });
    const fixture = await httpFixture({ jsonResponse, timeout: 3000 });
    await fixture.connection.start();
    fixture.config.startupTimeoutMs = 50;
    fixture.config.catalogTimeoutMs = 50;
    expect(
      (await fixture.connection.call("slow", { message: "long", delay: 1300 }))
        .content[0],
    ).toMatchObject({ text: "long" });
    expect(fixture.connection.status).toBe("Connected");
    expect(fixture.hasNotificationStream()).toBe(true);
    expect(getGlobalDispatcher()).toBe(routed);
    expect(requests.length).toBeGreaterThan(4);
    expect(
      requests.every(
        (request) => request.headersTimeout === 0 && request.bodyTimeout === 0,
      ),
    ).toBe(true);
    expect(fixture.calls).toEqual(["slow"]);
    expect(fixture.cancelled).toEqual([]);
  },
);

test.each([false, true])(
  "HTTP cancellation aborts only its response and still notifies the server (JSON=%s)",
  async (jsonResponse) => {
    const fixture = await httpFixture({ jsonResponse, timeout: 3000 });
    await fixture.connection.start();
    const abort = new AbortController();
    const result = fixture.connection.call(
      "slow",
      { message: "cancel", delay: 2000 },
      abort.signal,
    );
    const rejection = expect(result).rejects.toThrow();
    const sibling = fixture.connection.call("slow", {
      message: "sibling",
      delay: 400,
    });
    await expect.poll(() => fixture.calls.length).toBe(2);
    abort.abort();
    await rejection;
    await expect.poll(() => fixture.cancelled.length).toBe(1);
    await expect.poll(fixture.closedCalls).toBeGreaterThanOrEqual(1);
    expect((await sibling).content[0]).toMatchObject({ text: "sibling" });
    expect(
      (await fixture.connection.call("echo", { message: "usable" })).content[0],
    ).toMatchObject({ text: "usable" });
    expect(fixture.calls).toEqual(["slow", "slow", "echo"]);
  },
);

test.each(["application/json", "text/event-stream"] as const)(
  "a stalled %s response body is aborted at the tool deadline",
  async (stalledBody) => {
    const fixture = await httpFixture({ stalledBody, timeout: 100 });
    await fixture.connection.start();
    await expect(
      fixture.connection.call("slow", { message: "stall" }),
    ).rejects.toThrow("may already have taken effect");
    await expect.poll(fixture.closedCalls).toBe(1);
    await expect.poll(() => fixture.cancelled.length).toBe(1);
    expect(
      fixture.methods.filter((method) => method === "tools/call"),
    ).toHaveLength(1);
    expect(fixture.connection.status).toBe("Connected");
  },
);

test("a long call budget does not extend initialization or paginated catalog deadlines", async () => {
  const startup = await httpFixture({
    timeout: 960000,
    startupTimeoutMs: 80,
    initializeDelay: 250,
  });
  await expect(startup.connection.start()).rejects.toThrow("connection failed");
  const catalog = await httpFixture({
    timeout: 960000,
    catalogTimeoutMs: 150,
    catalogDelay: 90,
  });
  await expect(catalog.connection.start()).rejects.toThrow("discovery failed");
  expect(
    catalog.methods.filter((method) => method === "tools/list"),
  ).toHaveLength(2);
  expect(catalog.catalogs.at(-1)).toEqual([]);
  expect(catalog.calls).toEqual([]);
});

test("stdio calls have their own deadlines and cancellation preserves siblings", async () => {
  const config: ServerConfig = {
    name: "stdio",
    type: "stdio",
    description: "Fixture",
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/server.ts", import.meta.url))],
    env: {},
    cwd: process.cwd(),
    timeout: 1000,
    startupTimeoutMs: 2000,
    catalogTimeoutMs: 1000,
  };
  const connection = new Connection(config, () => {});
  cleanups.push(() => connection.close());
  await connection.start();
  config.startupTimeoutMs = 20;
  config.catalogTimeoutMs = 20;
  expect(
    (await connection.call("slow", { message: "long", delay: 100 })).content[0],
  ).toMatchObject({ text: "long" });
  config.timeout = 50;
  await expect(
    connection.call("slow", { message: "timeout", delay: 500 }),
  ).rejects.toThrow("may already have taken effect");
  config.timeout = 1000;
  const abort = new AbortController();
  const rejection = expect(
    connection.call("slow", { message: "cancel", delay: 500 }, abort.signal),
  ).rejects.toThrow();
  const sibling = connection.call("slow", { message: "sibling", delay: 100 });
  abort.abort();
  await rejection;
  expect((await sibling).content[0]).toMatchObject({ text: "sibling" });
});

test("aborting a completed or never-started HTTP call sends no stale cancellation", async () => {
  const fixture = await httpFixture();
  await fixture.connection.start();
  const done = new AbortController();
  await fixture.connection.call("echo", { message: "done" }, done.signal);
  done.abort();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    fixture.connection.call("echo", { message: "never" }, cancelled.signal),
  ).rejects.toThrow();
  await fixture.connection.call("echo", { message: "barrier" });
  expect(fixture.calls).toEqual(["echo", "echo"]);
  expect(fixture.cancelled).toEqual([]);
});

test.each(["startup", "call", "timeout"])(
  "HTTP control replies do not inherit a finished operation's abort signal (%s)",
  async (operation) => {
    const fixture = await httpFixture({ timeout: 100 });
    await fixture.connection.start();
    await expect.poll(fixture.hasNotificationStream).toBe(true);
    if (operation === "call")
      await fixture.connection.call("echo", { message: "done" });
    if (operation === "timeout")
      await expect(
        fixture.connection.call("slow", { message: "timeout", delay: 1000 }),
      ).rejects.toThrow("timed out");
    await expect(
      fixture.server.request({ method: "ping" }, EmptyResultSchema, {
        timeout: 1000,
      }),
    ).resolves.toEqual({});
    expect(fixture.methods).toContain("response");
    expect(fixture.connection.status).toBe("Connected");
  },
);

test("progress notifications cannot extend a tool deadline", async () => {
  const fixture = await httpFixture({ timeout: 150 });
  let progress = 0;
  fixture.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      fixture.calls.push(request.params.name);
      const timer = globalThis.setInterval(() => {
        progress++;
        void fixture.server
          .notification({
            method: "notifications/progress",
            params: { progressToken: extra.requestId, progress, total: 100 },
          })
          .catch(() => {});
      }, 20);
      try {
        await setTimeout(1000, undefined, { signal: extra.signal });
        return { content: [{ type: "text", text: "too late" }] };
      } finally {
        clearInterval(timer);
      }
    },
  );
  await fixture.connection.start();
  await expect(
    fixture.connection.call("slow", { message: "progress" }),
  ).rejects.toThrow("may already have taken effect");
  await expect.poll(() => fixture.cancelled.length).toBe(1);
  expect(progress).toBeGreaterThanOrEqual(2);
  expect(fixture.calls).toEqual(["slow"]);
});
