import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverAndLoadExtensions,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("Pi loads pix-websearch and invokes the tool without a UI or model request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pix-websearch-"));
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      results: [
        {
          url: "https://example.com/docs",
          title: "Docs",
          content: "Documentation",
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("PIX_WEBSEARCH_PROVIDER", "tavily");
  vi.stubEnv("TAVILY_API_KEY", "");
  try {
    const loaded = await discoverAndLoadExtensions(
      [fileURLToPath(new URL("../", import.meta.url))],
      directory,
      join(directory, "agent"),
    );
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    const tool = loaded.extensions[0]?.tools.get("websearch")?.definition;
    expect(tool).toBeDefined();
    if (!tool) throw new Error("Pi did not register websearch");
    const ctx = {
      hasUI: false,
      sessionManager: { getSessionId: () => "test-session" },
    } as unknown as ExtensionContext;
    const response = await tool.execute(
      "call-1",
      { query: "Pi docs" },
      undefined,
      undefined,
      ctx,
    );
    expect(response.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("https://example.com/docs"),
      },
    ]);
    expect(response.details).toEqual({
      provider: "tavily",
      results: [
        {
          url: "https://example.com/docs",
          title: "Docs",
          content: "Documentation",
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get(
        "X-Tavily-Access-Mode",
      ),
    ).toBe("keyless");
    await expect(
      tool.execute(
        "call-2",
        { query: "Pi" },
        AbortSignal.abort(),
        undefined,
        ctx,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
