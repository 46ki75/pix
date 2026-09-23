import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import { createHttp } from "./http.ts";

const endpoint = "https://search.example.test/mcp";
const result = { content: [{ type: "text", text: "results" }] };
const rpc = (id = 1) => ({ jsonrpc: "2.0", id, result });

function fixture(response: Response, options = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
  const http = createHttp({ fetch, ...options });
  return {
    fetch,
    http,
    call: (signal?: AbortSignal) =>
      http.callMcp(endpoint, "search", { query: "Pi" }, {}, signal),
  };
}

describe("HTTP and MCP transport", () => {
  test("sends JSON-RPC with unique IDs and accepts plain JSON", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return Response.json(rpc(body.id));
    });
    const http = createHttp({ fetch });
    await expect(
      http.callMcp(endpoint, "search", { query: "Pi" }, {}),
    ).resolves.toEqual(result);
    await http.callMcp(endpoint, "search", { query: "Pi" }, {});
    const requests = fetch.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(requests).toEqual(
      [1, 2].map((id) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "search", arguments: { query: "Pi" } },
      })),
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
    });
  });

  test("handles chunked UTF-8, CRLF, multiline SSE, and notifications; closes after the matching result", async () => {
    const unicode = { content: [{ type: "text", text: "日本語 🌐" }] };
    const source = [
      ": keepalive\r\n\r\n",
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n',
      `data: ${JSON.stringify(rpc(999))}\r\n\r\n`,
      'event: message\r\ndata:{"jsonrpc":"2.0",\r\n',
      `data: "id":1,"result":${JSON.stringify(unicode)}}\r\n\r\n`,
    ].join("");
    const bytes = new TextEncoder().encode(source);
    const cancel = vi.fn();
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < bytes.length)
          controller.enqueue(bytes.slice(index, ++index));
        // Leave the connection open after the result, as an SSE server may do.
      },
      cancel,
    });
    const { call } = fixture(
      new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    await expect(call()).resolves.toEqual(unicode);
    expect(cancel).toHaveBeenCalled();
  });

  test.each([
    { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "secret-value" } },
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        content: [{ type: "text", text: "secret-value" }],
      },
    },
    { jsonrpc: "2.0", id: 2, result },
    { jsonrpc: "1.0", id: 1, result },
  ])(
    "rejects failed or mismatched MCP responses without leaking their body: %j",
    async (body) => {
      const { call } = fixture(Response.json(body));
      await expect(call()).rejects.toThrow(/MCP|tool error/);
    },
  );

  test.each(["", "not json", '{"result":'])(
    "rejects empty/malformed bodies: %j",
    async (body) => {
      await expect(fixture(new Response(body)).call()).rejects.toThrow(
        "Invalid JSON",
      );
    },
  );

  test("does not report an SSE stream without a result as an empty search", async () => {
    const body = ": heartbeat\n\ndata: [DONE]\n\n";
    await expect(
      fixture(
        new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        }),
      ).call(),
    ).rejects.toThrow("Missing MCP");
  });

  test.each(["application/json", "text/event-stream"])(
    "bounds %s bodies and cancels the stream",
    async (contentType) => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(64));
          },
          cancel,
        }),
        { headers: { "Content-Type": contentType } },
      );
      const { call } = fixture(response, { maxResponseBytes: 100 });
      await expect(call()).rejects.toThrow("exceeded 100 bytes");
      expect(cancel).toHaveBeenCalled();
    },
  );

  test("retains rate-limit metadata and releases HTTP error bodies", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status: 429,
      headers: { "Retry-After": "90" },
    });
    await expect(fixture(response).call()).rejects.toMatchObject({
      status: 429,
      retryAfter: "90",
    });
    expect(cancel).toHaveBeenCalled();
  });

  test("honors cancellation before sending a request", async () => {
    const { call, fetch } = fixture(Response.json(rpc()));
    await expect(call(AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("cancels body consumption while waiting for the next chunk", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const controller = new AbortController();
    const pending = fixture(response).call(controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await delay(0);
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalled();
  });

  test("times out a response that sends headers but stalls its body", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    await expect(fixture(response, { timeoutMs: 10 }).call()).rejects.toThrow(
      "timed out",
    );
    expect(cancel).toHaveBeenCalled();
  });

  test("redacts network errors", async () => {
    const http = createHttp({
      fetch: async () => {
        throw new Error("https://example.test?key=secret");
      },
    });
    await expect(http.postJson(endpoint, {}, {})).rejects.toThrow(
      /^Search network request failed\.$/,
    );
  });
});
