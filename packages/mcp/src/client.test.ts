import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
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
    timeoutMs?: number;
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
    onsessionclosed: () => {
      deleted = true;
    },
  });
  await server.connect(transport as Transport);
  const methods: string[] = [];
  const authorizations: (string | undefined)[] = [];
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
        methods.push((body as { method: string }).method);
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
    timeoutMs: options.timeoutMs ?? 1000,
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
    timeoutMs: 100,
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
  config.timeoutMs = 100;
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
