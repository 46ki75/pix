import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { describe, expect, test, vi } from "vitest";
import { createWebFetch, MAX_REDIRECTS, MAX_URL_LENGTH } from "./fetch.ts";

const url = "https://example.com/docs/start";

function fixture(response: Response, options = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
  return { fetch, read: createWebFetch({ fetch, ...options }) };
}

describe("HTTP fetching", () => {
  test("uses GET and returns text with source metadata", async () => {
    const { read, fetch } = fixture(
      new Response("Hello 🌐", {
        headers: { "Content-Type": "Text/Plain; charset=UTF-8" },
      }),
    );
    await expect(read(`${url}#section`)).resolves.toEqual({
      url,
      contentType: "text/plain",
      text: "Hello 🌐",
      responseBytes: Buffer.byteLength("Hello 🌐"),
    });
    expect(fetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  test.each([
    "file:///etc/hosts",
    "ftp://example.com",
    "javascript:alert(1)",
    "",
    "/relative",
    "https://user:password@example.com",
  ])("rejects unsupported URL %s before requesting", async (input) => {
    const { read, fetch } = fixture(new Response("Hello"));
    await expect(read(input)).rejects.toThrow("requires an HTTP(S) URL");
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(["markdown", "text"] as const)(
    "negotiates %s and preserves server-provided Markdown",
    async (format) => {
      const text = "# Server Markdown\n\n```js\nconst x = 1;\n```\n";
      const { read, fetch } = fixture(
        new Response(text, { headers: { "Content-Type": "text/markdown" } }),
      );
      await expect(read(url, undefined, format)).resolves.toMatchObject({
        text,
        contentType: "text/markdown",
      });
      const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
      expect(headers.get("accept")?.split(",")[0]).toBe(
        format === "markdown" ? "text/markdown" : "text/plain",
      );
    },
  );

  test("rejects oversized URLs", async () => {
    const { read, fetch } = fixture(new Response("Hello"));
    await expect(
      read(`https://example.com/${"a".repeat(MAX_URL_LENGTH)}`),
    ).rejects.toThrow("requires an HTTP(S) URL");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("follows relative redirects and releases intermediate bodies", async () => {
    const cancel = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          status: 302,
          headers: { Location: "../guide" },
        }),
      )
      .mockResolvedValueOnce(new Response("Guide"));
    const page = await createWebFetch({ fetch })(url);
    expect(page.url).toBe("https://example.com/guide");
    expect(page.text).toBe("Guide");
    expect(cancel).toHaveBeenCalled();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      url,
      "https://example.com/guide",
    ]);
  });

  test.each([301, 303, 307, 308])("follows HTTP %i", async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status, headers: { Location: "/other" } }),
      )
      .mockResolvedValueOnce(new Response("Done"));
    await expect(createWebFetch({ fetch })(url)).resolves.toMatchObject({
      url: "https://example.com/other",
      text: "Done",
    });
  });

  test("rejects redirect loops and invalid redirect locations", async () => {
    for (const [location, message] of [
      [url, "redirect loop"],
      ["data:text/plain,hello", "HTTP(S) URL"],
      ["https://user:pass@example.com", "HTTP(S) URL"],
      ["", "missing a location"],
    ] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(null, { status: 302, headers: { Location: location } }),
      );
      await expect(createWebFetch({ fetch })(url)).rejects.toThrow(message);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  test("bounds redirect chains", async () => {
    let index = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: `/hop-${++index}` },
        }),
    );
    await expect(createWebFetch({ fetch })(url)).rejects.toThrow(
      `exceeded ${MAX_REDIRECTS} redirects`,
    );
    expect(fetch).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  test.each([404, 429, 500])(
    "reports HTTP %i without returning the error body",
    async (status) => {
      const cancel = vi.fn();
      const { read } = fixture(
        new Response(new ReadableStream({ cancel }), { status }),
      );
      await expect(read(url)).rejects.toThrow(
        `Web fetch failed (HTTP ${status}).`,
      );
      expect(cancel).toHaveBeenCalled();
    },
  );

  test.each(["image/png", "application/octet-stream"])(
    "rejects %s and releases its body",
    async (contentType) => {
      const cancel = vi.fn();
      const { read } = fixture(
        new Response(new ReadableStream({ cancel }), {
          headers: { "Content-Type": contentType },
        }),
      );
      await expect(read(url)).rejects.toThrow("unsupported content type");
      expect(cancel).toHaveBeenCalled();
    },
  );

  test.each([
    "text/markdown",
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/atom+xml",
    "application/yaml",
  ])("preserves %s text", async (contentType) => {
    const text = "  text with\n  indentation\n";
    await expect(
      fixture(
        new Response(text, { headers: { "Content-Type": contentType } }),
      ).read(url),
    ).resolves.toMatchObject({ text, contentType });
  });

  test("handles a missing content type and an empty body", async () => {
    const response = new Response(new TextEncoder().encode("plain text"));
    await expect(fixture(response).read(url)).resolves.toMatchObject({
      contentType: "text/plain",
      text: "plain text",
    });
    await expect(
      fixture(new Response(null, { status: 204 })).read(url),
    ).resolves.toMatchObject({ text: "", responseBytes: 0 });
  });

  test("detects binary NULs even when the content type is missing", async () => {
    await expect(
      fixture(new Response(new Uint8Array([65, 0, 66]))).read(url),
    ).rejects.toThrow("binary content");
  });

  test("decodes a declared charset and rejects unknown encodings", async () => {
    await expect(
      fixture(
        new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
          headers: { "Content-Type": 'text/plain; charset="iso-8859-1"' },
        }),
      ).read(url),
    ).resolves.toMatchObject({ text: "café" });
    const cancel = vi.fn();
    await expect(
      fixture(
        new Response(new ReadableStream({ cancel }), {
          headers: { "Content-Type": "text/plain; charset=not-an-encoding" },
        }),
      ).read(url),
    ).rejects.toThrow("unsupported character encoding");
    expect(cancel).toHaveBeenCalled();
  });

  test("decodes multibyte characters split across chunks", async () => {
    const text = "日本語 🌐";
    const bytes = new TextEncoder().encode(text);
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(index, ++index));
      },
    });
    await expect(fixture(new Response(body)).read(url)).resolves.toMatchObject({
      text,
      responseBytes: bytes.length,
    });
  });

  test("counts actual bytes instead of trusting Content-Length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64).fill(65));
      },
      cancel,
    });
    const { read } = fixture(
      new Response(body, { headers: { "Content-Length": "1" } }),
      { maxResponseBytes: 100 },
    );
    await expect(read(url)).rejects.toThrow("exceeded 100 bytes");
    expect(cancel).toHaveBeenCalled();
    await expect(
      fixture(new Response("a".repeat(100)), { maxResponseBytes: 100 }).read(
        url,
      ),
    ).resolves.toMatchObject({ responseBytes: 100 });
  });

  test("honors a pre-aborted signal without sending a request", async () => {
    const { fetch, read } = fixture(new Response("Hello"));
    await expect(read(url, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("cancels a stalled body read", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const pending = fixture(new Response(new ReadableStream({ cancel }))).read(
      url,
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await delay(0);
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalled();
  });

  test("stops redirecting when canceled", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      controller.abort();
      return new Response(null, {
        status: 302,
        headers: { Location: "/next" },
      });
    });
    await expect(
      createWebFetch({ fetch })(url, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("times out after receiving headers and cancels the body", async () => {
    const cancel = vi.fn();
    const { read } = fixture(new Response(new ReadableStream({ cancel })), {
      timeoutMs: 10,
    });
    await expect(read(url)).rejects.toThrow("timed out");
    expect(cancel).toHaveBeenCalled();
  });

  test("redacts native network errors", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("URL included secret-token"));
    await expect(createWebFetch({ fetch })(url)).rejects.toThrow(
      /^Web fetch network request failed\.$/,
    );
  });
});

test("native fetch follows a redirect and enforces limits on decompressed bytes", async () => {
  const text = "Hello 🌐\n".repeat(200);
  const compressed = gzipSync(text);
  const server = createServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { Location: "/text" }).end();
    } else {
      res
        .writeHead(200, {
          "Content-Type": "text/plain",
          "Content-Encoding": "gzip",
          "Content-Length": compressed.length,
        })
        .end(compressed);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test server address");
    const base = `http://127.0.0.1:${address.port}`;
    await expect(createWebFetch()(`${base}/start`)).resolves.toEqual({
      url: `${base}/text`,
      contentType: "text/plain",
      text,
      responseBytes: Buffer.byteLength(text),
    });
    expect(compressed.length).toBeLessThan(100);
    await expect(
      createWebFetch({ maxResponseBytes: 100 })(`${base}/start`),
    ).rejects.toThrow("exceeded 100 bytes");
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
});
