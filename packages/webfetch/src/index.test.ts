import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverAndLoadExtensions,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

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
        text: expect.stringContaining("docs [https://example.com/docs]"),
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

    const combined = await discoverAndLoadExtensions(
      [
        packagePath,
        fileURLToPath(new URL("../../websearch/", import.meta.url)),
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
