import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  EmptyResultSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, test } from "vitest";
import { Connection } from "./client.ts";
import type { ServerConfig } from "./config.ts";
import { fixtureServer, legacySchema } from "./fixtures/server.ts";

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
    stalledBody?: "application/json" | "text/event-stream";
    notificationContentType?: string;
    legacyOutput?: boolean;
  } = {},
) {
  const { server, calls } = fixtureServer();
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
  if (options.legacyOutput)
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "echo",
          inputSchema: { type: "object" },
          outputSchema: legacySchema,
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
    approve: false,
  };
  const catalogs: Tool[][] = [];
  const connection = new Connection(config, (tools) => catalogs.push(tools));
  cleanups.push(() => connection.close());
  return {
    connection,
    config,
    methods,
    authorizations,
    catalogs,
    calls,
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
  expect(catalogs.at(-1)).toHaveLength(5);
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

test("unrepresentable legacy output schemas fail discovery without running tools", async () => {
  const { connection, calls } = await httpFixture({ legacyOutput: true });
  await expect(connection.start()).rejects.toThrow("discovery failed");
  expect(calls).toEqual([]);
});

test("HTTP notifications refresh the catalog", async () => {
  const { connection, catalogs } = await httpFixture();
  await connection.start();
  await connection.call("change", { message: "update" });
  await expect.poll(() => catalogs.at(-1)?.[0]?.name).toBe("echo_v2");
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
      /^MCP server http: connection or discovery failed\.$/,
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
  await expect(startup.connection.start()).rejects.toThrow(
    "connection or discovery failed",
  );
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
    approve: false,
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
