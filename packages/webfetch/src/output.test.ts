import { once } from "node:events";
import { createServer } from "node:http";
import { expect, test, vi } from "vitest";
import type { SaveArtifact } from "./artifacts.ts";
import { createWebFetch, MAX_URL_LENGTH } from "./fetch.ts";
import { formatPage, MAX_OUTPUT_BYTES } from "./output.ts";

const page = {
  url: "https://example.com/docs",
  contentType: "text/plain",
  text: "",
  responseBytes: 123,
};
const path = "/temporary/pix-webfetch/fetch-abcdef/output.txt";
const header = "URL: https://example.com/docs\nContent-Type: text/plain\n\n";
const mockSave = () => vi.fn<SaveArtifact>().mockResolvedValue(path);

test("includes source metadata without creating an artifact for short output", async () => {
  const save = mockSave();
  const result = await formatPage(page, "Page content", "text", save);
  expect(result.content).toBe(`${header}Page content`);
  expect(result.details).toEqual({
    url: page.url,
    contentType: "text/plain",
    responseBytes: 123,
    truncated: false,
  });
  expect(save).not.toHaveBeenCalled();
});

test("bounds long-line UTF-8 output including metadata and the recovery notice", async () => {
  const save = mockSave();
  const text = "日本語🌐".repeat(MAX_OUTPUT_BYTES);
  const result = await formatPage(page, text, "text", save);
  expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(
    MAX_OUTPUT_BYTES,
  );
  expect(result.content).toContain(page.url);
  expect(result.content).not.toContain("�");
  expect(result.content).toContain(`[Content truncated. Full output: ${path}`);
  expect(result.content).toContain("Use read with offset/limit to continue.");
  expect(result.details).toMatchObject({
    truncated: true,
    fullOutputPath: path,
  });
  expect(save).toHaveBeenCalledWith(header + text, "txt", undefined);
});

test("prefers complete lines in the preview", async () => {
  const line = "A line that should stay complete.\n";
  const result = await formatPage(page, line.repeat(2_000), "text", mockSave());
  const preview = result.content
    .slice(header.length)
    .split("\n\n[Content truncated.")[0];
  expect(`${preview}\n`).toMatch(/^(A line that should stay complete\.\n)+$/);
  expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(
    MAX_OUTPUT_BYTES,
  );
});

test("handles output exactly at the byte limit and saves overflow only", async () => {
  const save = mockSave();
  const text = "x".repeat(MAX_OUTPUT_BYTES - Buffer.byteLength(header));
  const result = await formatPage(page, text, "text", save);
  expect(Buffer.byteLength(result.content)).toBe(MAX_OUTPUT_BYTES);
  expect(result.details.truncated).toBe(false);
  expect(save).not.toHaveBeenCalled();
  expect(
    (await formatPage(page, `${text}x`, "text", save)).details.truncated,
  ).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
});

test("regression: bounds previews with large metadata accepted by native fetch", async () => {
  const contentType = `text/${"x".repeat(16_275)}`;
  const body = "a".repeat(300);
  const server = createServer((_request, response) => {
    // Keep the HTTP header block below Node's limit while stressing the separate output budget.
    response.sendDate = false;
    response
      .writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(body),
        Connection: "close",
      })
      .end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test server address");
    const base = `http://127.0.0.1:${address.port}/?q=`;
    const url = base + "x".repeat(MAX_URL_LENGTH - base.length);
    const fetched = await createWebFetch()(url);
    expect(fetched).toMatchObject({ url, contentType, text: body });
    const save = mockSave();
    const result = await formatPage(fetched, fetched.text, "text", save);
    expect(result.details).toMatchObject({
      truncated: true,
      fullOutputPath: path,
      url,
      contentType,
    });
    expect(save).toHaveBeenCalledExactlyOnceWith(
      `URL: ${url}\nContent-Type: ${contentType}\n\n${body}`,
      "txt",
      undefined,
    );
    expect(result.content).toContain(
      `[Content truncated. Full output: ${path}`,
    );
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES,
    );
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
});

test.each([
  ["text/html", "markdown", "md"],
  ["application/xhtml+xml", "markdown", "md"],
  ["text/html", "text", "txt"],
  ["text/markdown", "text", "md"],
  ["application/json", "markdown", "txt"],
] as const)(
  "chooses the artifact extension for %s in %s mode",
  async (contentType, format, extension) => {
    const save = mockSave();
    await formatPage(
      { ...page, contentType },
      "x".repeat(MAX_OUTPUT_BYTES),
      format,
      save,
    );
    expect(save).toHaveBeenCalledWith(expect.any(String), extension, undefined);
  },
);

test("explains empty output", async () => {
  expect((await formatPage(page, " \n", "text", mockSave())).content).toContain(
    "No readable text found",
  );
});

test("propagates artifact failures and cancellation", async () => {
  const save = mockSave().mockRejectedValue(new Error("Could not save output"));
  await expect(
    formatPage(page, "x".repeat(MAX_OUTPUT_BYTES), "text", save),
  ).rejects.toThrow("Could not save output");
  save.mockClear();
  await expect(
    formatPage(
      page,
      "x".repeat(MAX_OUTPUT_BYTES),
      "text",
      save,
      AbortSignal.abort(),
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(save).not.toHaveBeenCalled();
});
