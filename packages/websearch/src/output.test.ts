import { expect, test } from "vitest";
import { formatResults, MAX_OUTPUT_BYTES } from "./output.ts";

test("renders source links, publication dates, and excerpts", () => {
  const text = formatResults({
    provider: "exa",
    results: [
      {
        url: "https://example.com/docs",
        title: "The [docs]",
        content: "Read this",
        published: 0,
      },
    ],
  });
  expect(text).toContain("## [The \\[docs\\]](<https://example.com/docs>)");
  expect(text).toContain("Published: 1970-01-01T00:00:00.000Z");
  expect(text).toContain("Read this");
});

test("bounds UTF-8 output while keeping source links and explaining shortened excerpts", () => {
  const results = Array.from({ length: 8 }, (_, i) => ({
    url: `https://example.com/${i}`,
    title: `Result ${i}`,
    content: "🌐日本語".repeat(4_000),
  }));
  const text = formatResults({ provider: "parallel", results });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  for (const result of results) expect(text).toContain(result.url);
  expect(text).not.toContain("�");
  expect(text).toContain("Results shortened");
});

test("shortens oversized titles while retaining their source link", () => {
  const text = formatResults({
    provider: "tavily",
    results: [
      { url: "https://example.com", title: "x".repeat(MAX_OUTPUT_BYTES * 2) },
    ],
  });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  expect(text).toContain("Results shortened");
  expect(text).toContain("https://example.com");
});

test("keeps output bounded when a link nearly consumes the entire budget", () => {
  for (let spare = 0; spare < 200; spare++) {
    const text = formatResults({
      provider: "exa",
      results: [
        {
          url: `https://example.com/${"a".repeat(MAX_OUTPUT_BYTES - spare)}`,
          title: "Link",
          content: "An excerpt",
        },
      ],
    });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  }
});

test("provides a useful empty-results message", () => {
  expect(formatResults({ provider: "tavily", results: [] })).toContain(
    "No search results found",
  );
});
