import { pathToFileURL } from "node:url";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type {
  ExtensionContext,
  McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import {
  FixtureRpcError,
  PromptFixtureServer,
  type PromptFixtureOptions,
} from "./fixtures/server.ts";
import type { Prompt } from "./protocol.ts";

const createNativeTransport = vi.hoisted(() => vi.fn());
vi.mock("./native.ts", () => ({ createNativeTransport }));

import { Connection } from "./client.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  createNativeTransport.mockReset();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const context = {
  cwd: "/workspace/project",
  modelRegistry: {},
} as ExtensionContext;

function entry(timeout = 1): McpServerEntry {
  return {
    name: "fixture",
    config: { command: "fixture", timeout },
    source: "fixture",
  };
}

async function serverTransport(options: PromptFixtureOptions = {}) {
  const pair = createInMemoryTransportPair();
  const server = new PromptFixtureServer(pair.server, options);
  await server.start();
  const settled = vi.fn(async () => {});
  createNativeTransport.mockResolvedValueOnce({
    transport: pair.client,
    settled,
  });
  cleanups.push(() => server.close());
  return { server, transport: pair.client, settled };
}

async function fixture(
  options: PromptFixtureOptions = {},
  timeout = 1,
  changed?: (prompts: Prompt[]) => void,
) {
  const transport = await serverTransport(options);
  const catalogs: Prompt[][] = [];
  const connection = new Connection(entry(timeout), context, (prompts) => {
    catalogs.push(prompts);
    changed?.(prompts);
  });
  cleanups.push(() => connection.close());
  return { ...transport, connection, catalogs };
}

test("discovers only paginated prompts, gets all content shapes, and serves the session root", async () => {
  const requests: string[] = [];
  const testFixture = await fixture({
    capabilities: {
      prompts: { listChanged: true },
      tools: { listChanged: true },
      resources: { listChanged: true },
    },
    request: (method, params) => {
      requests.push(method);
      if (method === "prompts/list")
        return params?.cursor === "next"
          ? {
              prompts: [
                {
                  name: "conversation",
                  _meta: { provider: "fixture" },
                },
              ],
            }
          : {
              prompts: [
                {
                  name: "review",
                  title: "Review",
                  arguments: [{ name: "topic", required: true }],
                },
              ],
              nextCursor: "next",
            };
      if (method === "prompts/get")
        return {
          description: "Rendered",
          messages: [
            { role: "user", content: { type: "text", text: "Question" } },
            {
              role: "assistant",
              content: {
                type: "image",
                mimeType: "image/png",
                data: "aGVsbG8=",
              },
            },
            {
              role: "user",
              content: {
                type: "resource_link",
                uri: "fixture://notes",
                name: "Notes",
              },
            },
            {
              role: "user",
              content: {
                type: "resource",
                resource: { uri: "fixture://notes", text: "Reference" },
              },
            },
          ],
        };
      throw new FixtureRpcError(-32601, "Malformed mixed feature was queried");
    },
  });

  expect(testFixture.connection.start()).toBe(testFixture.connection.start());
  await testFixture.connection.start();
  expect(testFixture.catalogs.at(-1)?.map((prompt) => prompt.name)).toEqual([
    "review",
    "conversation",
  ]);
  expect(testFixture.connection.promptStatus).toBe("Available");
  await expect(
    testFixture.connection.getPrompt("review", { topic: "deadlines" }),
  ).resolves.toMatchObject({
    description: "Rendered",
    messages: [
      { content: { type: "text" } },
      { content: { type: "image" } },
      { content: { type: "resource_link" } },
      { content: { type: "resource" } },
    ],
  });
  expect(requests).toEqual(["prompts/list", "prompts/list", "prompts/get"]);
  expect(
    testFixture.server.methods.some((method) =>
      /^(tools|resources)\//.test(method),
    ),
  ).toBe(false);
  await expect(testFixture.server.requestRoots()).resolves.toEqual({
    roots: [
      {
        uri: pathToFileURL(context.cwd).href,
        name: "project",
      },
    ],
  });
});

test("does not query prompts when the server lacks the capability", async () => {
  const testFixture = await fixture({ capabilities: { tools: {} } });
  await testFixture.connection.start();
  expect(testFixture.connection.promptStatus).toBe("Not supported");
  expect(testFixture.catalogs.at(-1)).toEqual([]);
  expect(testFixture.server.methods).not.toContain("prompts/list");
  await expect(
    testFixture.connection.getPrompt("review", undefined),
  ).rejects.toThrow("unavailable");
  expect(testFixture.server.methods).not.toContain("prompts/get");
});

test.each([
  {
    name: "repeated cursor",
    response: () => ({ prompts: [], nextCursor: "repeat" }),
  },
  {
    name: "duplicate names across pages",
    response: (call: number) => ({
      prompts: [{ name: "same" }],
      ...(call === 1 ? { nextCursor: "next" } : {}),
    }),
  },
  {
    name: "invalid metadata",
    response: () => ({ prompts: [{ name: "safe\u202Espoofed" }] }),
  },
  {
    name: "duplicate arguments",
    response: () => ({
      prompts: [
        { name: "review", arguments: [{ name: "topic" }, { name: "topic" }] },
      ],
    }),
  },
])("rejects $name and leaves no partial catalog", async ({ response }) => {
  let calls = 0;
  const testFixture = await fixture({
    request: (method) => {
      if (method !== "prompts/list") throw new Error("Unexpected request");
      return response(++calls);
    },
  });
  await expect(testFixture.connection.start()).rejects.toThrow(
    /^MCP server fixture: prompt discovery failed\.$/,
  );
  expect(testFixture.connection.promptStatus).toContain("failed");
  expect(testFixture.catalogs.at(-1)).toEqual([]);
});

test("enforces the aggregate prompt count across pages", async () => {
  let page = 0;
  const testFixture = await fixture({
    request: () => {
      page++;
      return {
        prompts: Array.from({ length: page === 1 ? 600 : 401 }, (_, index) => ({
          name: `prompt-${page}-${index}`,
        })),
        ...(page === 1 ? { nextCursor: "second" } : {}),
      };
    },
  });
  await expect(testFixture.connection.start()).rejects.toThrow(
    "prompt discovery failed",
  );
  expect(testFixture.catalogs.at(-1)).toEqual([]);
});

test("enforces the aggregate prompt catalog byte limit across pages", async () => {
  let page = 0;
  const testFixture = await fixture({
    request: () => {
      page++;
      return {
        prompts: Array.from({ length: 100 }, (_, index) => ({
          name: `prompt-${page}-${index}`,
          description: "x".repeat(8 * 1024),
        })),
        ...(page < 3 ? { nextCursor: `page-${page + 1}` } : {}),
      };
    },
  });
  await expect(testFixture.connection.start()).rejects.toThrow(
    "prompt discovery failed",
  );
  expect(testFixture.catalogs.at(-1)).toEqual([]);
});

test("prompt notifications invalidate immediately and never publish a dirty snapshot", async () => {
  const releaseSecond = deferred<void>();
  let listCall = 0;
  let server!: PromptFixtureServer;
  const testFixture = await fixture({
    request: async (method) => {
      if (method !== "prompts/list") throw new Error("Unexpected request");
      listCall++;
      if (listCall === 1) return { prompts: [{ name: "first" }] };
      if (listCall === 2) {
        await server.notifyPromptsChanged();
        await releaseSecond.promise;
        return { prompts: [{ name: "stale-second" }] };
      }
      return { prompts: [{ name: "third" }] };
    },
  });
  server = testFixture.server;
  await testFixture.connection.start();
  expect(testFixture.catalogs.at(-1)?.[0]?.name).toBe("first");

  await server.notifyPromptsChanged();
  await expect.poll(() => testFixture.catalogs.at(-1)).toEqual([]);
  releaseSecond.resolve();
  await expect.poll(() => testFixture.catalogs.at(-1)?.[0]?.name).toBe("third");
  expect(
    testFixture.catalogs.some((items) => items[0]?.name === "stale-second"),
  ).toBe(false);
  expect(testFixture.connection.promptStatus).toBe("Available");
});

test("failed notification refreshes clear stale prompts", async () => {
  let fail = false;
  const testFixture = await fixture({
    request: (method) => {
      if (method === "prompts/list") {
        if (fail) throw new FixtureRpcError(-32000, "SECRET catalog error");
        return { prompts: [{ name: "review" }] };
      }
      throw new Error("A stale prompt must not be requested");
    },
  });
  await testFixture.connection.start();
  fail = true;
  await testFixture.server.notifyPromptsChanged();
  await expect
    .poll(() => testFixture.connection.promptStatus)
    .toContain("failed");
  expect(testFixture.catalogs.at(-1)).toEqual([]);
  await expect(
    testFixture.connection.getPrompt("review", undefined),
  ).rejects.toThrow("prompt discovery failed");
  expect(testFixture.server.methods).not.toContain("prompts/get");
});

test("connection failures are sanitized and the next start reconnects", async () => {
  const failed = await serverTransport({
    initialize: () => {
      throw new FixtureRpcError(-32000, "SECRET token and stderr");
    },
  });
  const healthy = await serverTransport();
  const catalogs: Prompt[][] = [];
  const connection = new Connection(entry(), context, (prompts) =>
    catalogs.push(prompts),
  );
  cleanups.push(() => connection.close());

  await expect(connection.start()).rejects.toThrow(
    /^MCP server fixture: connection failed\.$/,
  );
  expect(connection.promptStatus).toContain("failed");
  await expect(connection.start()).resolves.toBeUndefined();
  expect(connection.promptStatus).toBe("Available");
  expect(catalogs.at(-1)?.[0]?.name).toBe("review");
  expect(createNativeTransport).toHaveBeenCalledTimes(2);
  expect(failed.settled).toHaveBeenCalledTimes(1);
  expect(healthy.server.methods).toContain("prompts/list");
});

test("a dropped connection withdraws prompts and getPrompt reconnects lazily", async () => {
  const first = await serverTransport();
  const catalogs: Prompt[][] = [];
  const connection = new Connection(entry(), context, (prompts) =>
    catalogs.push(prompts),
  );
  cleanups.push(() => connection.close());
  await connection.start();

  const second = await serverTransport();
  await first.server.close();
  await expect.poll(() => connection.promptStatus).toContain("reconnect");
  expect(catalogs.at(-1)).toEqual([]);
  await expect(
    connection.getPrompt("review", undefined),
  ).resolves.toMatchObject({
    messages: [{ content: { text: "Review this." } }],
  });
  expect(createNativeTransport).toHaveBeenCalledTimes(2);
  expect(second.server.methods).toContain("prompts/get");
});

test("prompt cancellation reaches the server and is never retried", async () => {
  let getCalls = 0;
  const testFixture = await fixture({
    request: (method) => {
      if (method === "prompts/list") return { prompts: [{ name: "slow" }] };
      if (method === "prompts/get") {
        getCalls++;
        return new Promise(() => {});
      }
      throw new Error("Unexpected request");
    },
  });
  await testFixture.connection.start();
  const controller = new AbortController();
  const request = testFixture.connection.getPrompt(
    "slow",
    undefined,
    controller.signal,
  );
  await expect.poll(() => getCalls).toBe(1);
  controller.abort(new Error("cancelled by test"));
  await expect(request).rejects.toThrow("cancelled by test");
  await expect.poll(() => testFixture.server.cancellations.length).toBe(1);
  expect(getCalls).toBe(1);
});

test("close aborts an in-flight prompt and is idempotent", async () => {
  const testFixture = await fixture({
    request: (method) =>
      method === "prompts/list"
        ? { prompts: [{ name: "slow" }] }
        : new Promise(() => {}),
  });
  await testFixture.connection.start();
  const request = testFixture.connection.getPrompt("slow", undefined);
  await expect
    .poll(
      () =>
        testFixture.server.methods.filter((method) => method === "prompts/get")
          .length,
    )
    .toBe(1);
  expect(testFixture.connection.close()).toBe(testFixture.connection.close());
  await testFixture.connection.close();
  await expect(request).rejects.toThrow();
  expect(testFixture.connection.promptStatus).toBe("Closed");
  expect(testFixture.settled).toHaveBeenCalledTimes(1);
});

test("close during initialization aborts startup and settles transport ownership", async () => {
  const testFixture = await fixture({
    initialize: () => new Promise(() => {}),
  });
  const started = testFixture.connection.start();
  await expect.poll(() => testFixture.server.methods).toContain("initialize");
  const closed = testFixture.connection.close();
  await closed;
  await expect(started).rejects.toThrow("connection failed");
  expect(testFixture.connection.promptStatus).toBe("Closed");
  expect(testFixture.settled).toHaveBeenCalledTimes(1);
});

test("close does not wait forever for transport creation and closes a late transport", async () => {
  const pair = createInMemoryTransportPair();
  const server = new PromptFixtureServer(pair.server);
  await server.start();
  cleanups.push(() => server.close());
  const pending = deferred<{
    transport: typeof pair.client;
    settled: () => Promise<void>;
  }>();
  const settled = vi.fn(async () => {});
  createNativeTransport.mockReturnValueOnce(pending.promise);
  const connection = new Connection(entry(), context, () => {});
  const started = connection.start();
  await expect.poll(() => createNativeTransport).toHaveBeenCalledTimes(1);
  await connection.close();
  await expect(started).rejects.toThrow("connection failed");

  pending.resolve({ transport: pair.client, settled });
  await expect.poll(() => settled).toHaveBeenCalledTimes(1);
  await expect(pair.client.start()).rejects.toThrow();
});

test("native progress renews the configured prompt request timeout", async () => {
  vi.useFakeTimers();
  const testFixture = await fixture(
    {
      request: async (method, _params, request) => {
        if (method === "prompts/list") return { prompts: [{ name: "slow" }] };
        if (method !== "prompts/get") throw new Error("Unexpected request");
        for (let progress = 1; progress <= 4; progress++) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          await request.progress(progress);
        }
        return {
          messages: [
            { role: "user", content: { type: "text", text: "completed" } },
          ],
        };
      },
    },
    0.05,
  );
  await testFixture.connection.start();
  const completed = expect(
    testFixture.connection.getPrompt("slow", undefined),
  ).resolves.toMatchObject({ messages: [{ content: { text: "completed" } }] });
  await vi.advanceTimersByTimeAsync(121);
  await completed;
});

test("bounds prompt arguments before sending and sanitizes get failures", async () => {
  let calls = 0;
  const testFixture = await fixture({
    request: (method) => {
      if (method === "prompts/list") return { prompts: [{ name: "review" }] };
      calls++;
      throw new FixtureRpcError(-32000, "SECRET result");
    },
  });
  await testFixture.connection.start();
  await expect(
    testFixture.connection.getPrompt("review", {
      topic: "x".repeat(256 * 1024),
    }),
  ).rejects.toThrow("exceed");
  expect(calls).toBe(0);
  const error = await testFixture.connection
    .getPrompt("review", undefined)
    .catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch("do not retry blindly");
  expect((error as Error).message).not.toContain("SECRET");
  expect(calls).toBe(1);
});
