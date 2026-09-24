import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverAndLoadExtensions,
  createReadTool,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("Pi loads webfetch independently and can load it alongside websearch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pix-webfetch-"));
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response('<h1>Guide</h1><p>Read the <a href="/docs">docs</a>.</p>', {
        headers: { "Content-Type": "text/html" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  try {
    const packagePath = fileURLToPath(new URL("../", import.meta.url));
    const loaded = await discoverAndLoadExtensions(
      [packagePath],
      directory,
      join(directory, "agent"),
    );
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    const tool = loaded.extensions[0]?.tools.get("webfetch")?.definition;
    if (!tool) throw new Error("Pi did not register webfetch");
    const ctx = { hasUI: false } as ExtensionContext;
    const response = await tool.execute(
      "call-1",
      { url: "https://example.com/guide" },
      undefined,
      undefined,
      ctx,
    );
    expect(response.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("[docs](https://example.com/docs)"),
      },
    ]);
    expect(response.details).toMatchObject({
      url: "https://example.com/guide",
      contentType: "text/html",
      truncated: false,
    });
    await expect(
      tool.execute(
        "call-2",
        { url: "https://example.com/guide" },
        AbortSignal.abort(),
        undefined,
        ctx,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);

    const plain = await tool.execute(
      "call-text",
      { url: "https://example.com/guide", format: "text" },
      undefined,
      undefined,
      ctx,
    );
    expect(plain.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("docs [https://example.com/docs]"),
      },
    ]);

    const combined = await discoverAndLoadExtensions(
      [
        packagePath,
        fileURLToPath(new URL("../../pix-websearch/", import.meta.url)),
      ],
      directory,
      join(directory, "agent"),
    );
    expect(combined.errors).toEqual([]);
    expect(
      combined.extensions.flatMap((extension) => [...extension.tools.keys()]),
    ).toEqual(["webfetch", "websearch"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi can read later sections from the full-output artifact after a redirect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pix-webfetch-read-"));
  vi.stubEnv("TMPDIR", directory);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: "/docs/final" } }),
    )
    .mockResolvedValueOnce(
      new Response(
        `<h1>Guide</h1><p><a href="next">Next</a></p>${"<p>Repeated paragraph for the preview limit.</p>".repeat(1_000)}<h2>Final section</h2><p>Recovery succeeded.</p>`,
        { headers: { "Content-Type": "text/html" } },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  try {
    const loaded = await discoverAndLoadExtensions(
      [fileURLToPath(new URL("../", import.meta.url))],
      directory,
      join(directory, "agent"),
    );
    expect(loaded.errors).toEqual([]);
    const tool = loaded.extensions[0]?.tools.get("webfetch")?.definition;
    if (!tool) throw new Error("Pi did not register webfetch");
    const result = await tool.execute(
      "call-long",
      { url: "https://example.com/start" },
      undefined,
      undefined,
      { hasUI: false } as ExtensionContext,
    );
    const details = result.details as {
      fullOutputPath: string;
      truncated: boolean;
      url: string;
    };
    expect(details).toMatchObject({
      truncated: true,
      url: "https://example.com/docs/final",
    });
    expect(details.fullOutputPath.startsWith(directory)).toBe(true);
    expect(details.fullOutputPath.endsWith(".md")).toBe(true);
    const preview = result.content[0];
    if (preview?.type !== "text") throw new Error("Missing preview");
    expect(Buffer.byteLength(preview.text)).toBeLessThanOrEqual(24 * 1024);
    expect(preview.text).toContain("[Next](https://example.com/docs/next)");
    expect(preview.text).toContain(details.fullOutputPath);
    expect(preview.text).not.toContain("Recovery succeeded");
    const full = await readFile(details.fullOutputPath, "utf8");
    const offset =
      full.split("\n").findIndex((line) => line === "## Final section") + 1;
    expect(offset).toBeGreaterThan(0);
    const read = await createReadTool(directory).execute("read-full", {
      path: details.fullOutputPath,
      offset,
      limit: 5,
    });
    expect(read.content).toEqual([
      { type: "text", text: expect.stringContaining("Recovery succeeded\\.") },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
