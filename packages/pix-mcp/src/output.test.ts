import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test } from "vitest";
import { formatResult, MAX_TEXT_BYTES } from "./output.ts";

test("keeps text, supported images and small structured results", async () => {
  const response = await formatResult({
    content: [
      { type: "text", text: "ok" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ],
    structuredContent: { ok: true },
  });
  expect(response.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("ok"),
  });
  expect(response.content[1]).toEqual({
    type: "image",
    mimeType: "image/png",
    data: "aGVsbG8=",
  });
  expect(response.details).toEqual({
    truncated: false,
    structuredContent: { ok: true },
  });
});

test.each([0, 1, 2])(
  "enforces the decoded 4 MiB image boundary (extra bytes=%s)",
  async (extra) => {
    const data = Buffer.alloc(4 * 1024 * 1024 + extra).toString("base64");
    const response = await formatResult({
      content: [{ type: "image", mimeType: "image/png", data }],
    });
    const path = response.details.fullOutputPath;
    try {
      expect(response.content.some((block) => block.type === "image")).toBe(
        extra === 0,
      );
      expect(response.details.truncated).toBe(extra !== 0);
      if (extra > 0) {
        expect(path).toBeDefined();
        if (!path) throw new Error("Missing full image artifact");
        expect(JSON.parse(await readFile(path, "utf8")).content[0].data).toBe(
          data,
        );
      }
    } finally {
      if (path) await rm(dirname(path), { recursive: true, force: true });
    }
  },
);

test("spills oversized output, large details and unsupported content without silently dropping it", async () => {
  const response = await formatResult({
    content: [
      { type: "text", text: "日本語\n".repeat(9000) },
      { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
    ],
    structuredContent: { data: "x".repeat(20_000) },
  });
  const path = response.details.fullOutputPath;
  expect(path).toBeDefined();
  if (!path) throw new Error("No artifact");
  try {
    expect(response.details).not.toHaveProperty("structuredContent");
    expect(response.details.structuredContentOmitted).toBe(true);
    const text = response.content[0];
    if (text?.type !== "text") throw new Error("Missing text");
    expect(Buffer.byteLength(text.text)).toBeLessThan(MAX_TEXT_BYTES + 1000);
    expect(text.text).not.toContain("�");
    expect(text.text).toContain(path);
    const full = JSON.parse(await readFile(path, "utf8"));
    expect(full.content[1].type).toBe("audio");
    expect(full.structuredContent.data.length).toBe(20_000);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});
