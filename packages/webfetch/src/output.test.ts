import { expect, test } from "vitest";
import { formatPage, MAX_OUTPUT_BYTES } from "./output.ts";

const page = {
  url: "https://example.com/docs",
  contentType: "text/plain",
  text: "",
  responseBytes: 123,
};

test("includes the source and metadata without storing the full body in details", () => {
  const result = formatPage(page, "Page content");
  expect(result.content).toBe(
    "URL: https://example.com/docs\nContent-Type: text/plain\n\nPage content",
  );
  expect(result.details).toEqual({
    url: page.url,
    contentType: "text/plain",
    responseBytes: 123,
    truncated: false,
  });
});

test("bounds UTF-8 output including metadata and a truncation notice", () => {
  const result = formatPage(page, "日本語🌐".repeat(MAX_OUTPUT_BYTES));
  expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(
    MAX_OUTPUT_BYTES,
  );
  expect(result.content).toContain(page.url);
  expect(result.content).not.toContain("�");
  expect(result.content).toContain("[Content truncated");
  expect(result.details.truncated).toBe(true);
});

test("handles output exactly at the byte limit", () => {
  const overhead = Buffer.byteLength(formatPage(page, "x").content) - 1;
  const result = formatPage(page, "x".repeat(MAX_OUTPUT_BYTES - overhead));
  expect(Buffer.byteLength(result.content)).toBe(MAX_OUTPUT_BYTES);
  expect(result.details.truncated).toBe(false);
  expect(
    formatPage(page, "x".repeat(MAX_OUTPUT_BYTES - overhead + 1)).details
      .truncated,
  ).toBe(true);
});

test("explains empty output", () => {
  expect(formatPage(page, " \n").content).toContain("No readable text found");
});
