import { describe, expect, test, vi } from "vitest";
import { createSearch } from "./search.ts";
import { type Provider, SearchError, selectionFromEnv } from "./types.ts";

const limited = (retryAfter?: string) =>
  new SearchError("Rate limited", {
    status: 429,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
const options = { selection: "auto", sessionId: "session-1" } as const;
function provider(
  id: Provider["id"],
): Provider & { search: ReturnType<typeof vi.fn<Provider["search"]>> } {
  return {
    id,
    search: vi
      .fn<Provider["search"]>()
      .mockResolvedValue([{ url: `https://${id}.example.com` }]),
  };
}

describe("provider selection", () => {
  test("keeps the selected provider for a session, with independent session choices", async () => {
    const exa = provider("exa"),
      tavily = provider("tavily");
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValue(0.99);
    const search = createSearch([exa, tavily], { random });
    expect((await search.search("Pi", options)).provider).toBe("exa");
    expect((await search.search("Pi again", options)).provider).toBe("exa");
    expect(
      (await search.search("Pi", { ...options, sessionId: "session-2" }))
        .provider,
    ).toBe("tavily");
    expect(random).toHaveBeenCalledTimes(2);
  });

  test("fails over on 429, shares cooldowns across sessions, and keeps the replacement", async () => {
    let now = 0;
    const exa = provider("exa"),
      tavily = provider("tavily");
    exa.search.mockRejectedValueOnce(limited("2"));
    const search = createSearch([exa, tavily], {
      now: () => now,
      random: () => 0,
    });
    expect((await search.search("Pi", options)).provider).toBe("tavily");
    expect(
      (await search.search("Pi", { ...options, sessionId: "other" })).provider,
    ).toBe("tavily");
    expect(exa.search).toHaveBeenCalledTimes(1);
    now = 2_001;
    expect((await search.search("Pi", options)).provider).toBe("tavily");
    expect(
      (await search.search("Pi", { ...options, sessionId: "new" })).provider,
    ).toBe("exa");
  });

  test.each([
    [undefined, 60_000],
    ["bad", 60_000],
    ["-1", 60_000],
    ["", 60_000],
    ["3", 3_000],
    ["0.5", 500],
    ["Thu, 01 Jan 1970 00:00:04 GMT", 4_000],
  ] as const)("honors Retry-After %j", async (header, milliseconds) => {
    let now = 0;
    const exa = provider("exa");
    exa.search.mockRejectedValueOnce(limited(header));
    const search = createSearch([exa], { now: () => now });
    await expect(search.search("Pi", options)).rejects.toThrow("rate limited");
    now = milliseconds - 1;
    await expect(search.search("Pi", options)).rejects.toThrow("rate limited");
    expect(exa.search).toHaveBeenCalledTimes(1);
    now = milliseconds;
    await expect(search.search("Pi", options)).resolves.toMatchObject({
      provider: "exa",
    });
  });

  test("tries each provider once even when Retry-After is zero", async () => {
    const exa = provider("exa"),
      tavily = provider("tavily");
    exa.search.mockRejectedValue(limited("0"));
    tavily.search.mockRejectedValue(limited("0"));
    const search = createSearch([exa, tavily], { random: () => 0 });
    await expect(search.search("Pi", options)).rejects.toThrow("rate limited");
    expect(exa.search).toHaveBeenCalledTimes(1);
    expect(tavily.search).toHaveBeenCalledTimes(1);
  });

  test.each([401, 500])("does not rotate on HTTP %i", async (status) => {
    const exa = provider("exa"),
      tavily = provider("tavily");
    exa.search.mockRejectedValue(new SearchError(`HTTP ${status}`, { status }));
    const search = createSearch([exa, tavily], { random: () => 0 });
    await expect(search.search("Pi", options)).rejects.toThrow(
      `via exa: HTTP ${status}`,
    );
    expect(tavily.search).not.toHaveBeenCalled();
  });

  test("keeps explicitly selected providers pinned on rate limits", async () => {
    const exa = provider("exa"),
      tavily = provider("tavily");
    exa.search.mockRejectedValue(limited());
    const search = createSearch([exa, tavily]);
    await expect(
      search.search("Pi", { ...options, selection: "exa" }),
    ).rejects.toThrow("via exa");
    expect(tavily.search).not.toHaveBeenCalled();
  });

  test("preserves cancellation and never fails over after an abort", async () => {
    const exa = provider("exa"),
      tavily = provider("tavily");
    const controller = new AbortController();
    exa.search.mockImplementation(async () => {
      controller.abort();
      throw limited();
    });
    const search = createSearch([exa, tavily], { random: () => 0 });
    await expect(
      search.search("Pi", { ...options, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(tavily.search).not.toHaveBeenCalled();
  });

  test("a late success cannot overwrite a concurrently selected replacement", async () => {
    const exa = provider("exa"),
      tavily = provider("tavily");
    let finish:
      | ((results: Awaited<ReturnType<Provider["search"]>>) => void)
      | undefined;
    const pending = new Promise<Awaited<ReturnType<Provider["search"]>>>(
      (resolve) => {
        finish = resolve;
      },
    );
    exa.search.mockReturnValueOnce(pending).mockRejectedValueOnce(limited());
    const search = createSearch([exa, tavily], { random: () => 0 });
    const first = search.search("first", options);
    expect((await search.search("second", options)).provider).toBe("tavily");
    expect(finish).toBeDefined();
    finish?.([]);
    await first;
    expect((await search.search("third", options)).provider).toBe("tavily");
  });

  test("clears session affinity but retains provider cooldowns", async () => {
    const exa = provider("exa"),
      tavily = provider("tavily");
    exa.search.mockRejectedValueOnce(limited());
    const search = createSearch([exa, tavily], {
      now: () => 0,
      random: () => 0,
    });
    await search.search("Pi", options);
    search.clearSessions();
    await search.search("Pi", options);
    expect(exa.search).toHaveBeenCalledTimes(1);
  });

  test("trims queries, rejects blank/oversized inputs, and caps results", async () => {
    const exa = provider("exa");
    exa.search.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({
        url: `https://example.com/${i}`,
      })),
    );
    const search = createSearch([exa]);
    expect((await search.search(" Pi ", options)).results).toHaveLength(8);
    expect(exa.search).toHaveBeenCalledWith("Pi", undefined);
    await expect(search.search("   ", options)).rejects.toThrow("query");
    await expect(search.search("x".repeat(4_001), options)).rejects.toThrow(
      "query",
    );
    expect(exa.search).toHaveBeenCalledTimes(1);
  });

  test("restricts automatic selection and 429 fallback to the configured pool", async () => {
    const exa = provider("exa"),
      parallel = provider("parallel"),
      tavily = provider("tavily");
    exa.search.mockRejectedValueOnce(limited());
    const search = createSearch([exa, parallel, tavily], { random: () => 0 });
    const pool = { ...options, selection: ["exa", "tavily"] as const };
    expect((await search.search("first", pool)).provider).toBe("tavily");
    expect((await search.search("second", pool)).provider).toBe("tavily");
    expect(exa.search).toHaveBeenCalledTimes(1);
    expect(tavily.search).toHaveBeenCalledTimes(2);
    expect(parallel.search).not.toHaveBeenCalled();
  });

  test("never falls back outside a rate-limited pool", async () => {
    const exa = provider("exa"),
      parallel = provider("parallel"),
      tavily = provider("tavily");
    exa.search.mockRejectedValue(limited("0"));
    tavily.search.mockRejectedValue(limited("0"));
    const search = createSearch([exa, parallel, tavily], { random: () => 0 });
    await expect(
      search.search("Pi", { ...options, selection: ["exa", "tavily"] }),
    ).rejects.toThrow("rate limited");
    expect(exa.search).toHaveBeenCalledTimes(1);
    expect(tavily.search).toHaveBeenCalledTimes(1);
    expect(parallel.search).not.toHaveBeenCalled();
  });

  test("does not reuse session affinity for a provider excluded by a changed pool", async () => {
    const exa = provider("exa"),
      parallel = provider("parallel"),
      tavily = provider("tavily");
    const search = createSearch([exa, parallel, tavily], { random: () => 0 });
    expect(
      (
        await search.search("first", {
          ...options,
          selection: ["exa", "tavily"],
        })
      ).provider,
    ).toBe("exa");
    expect(
      (
        await search.search("second", {
          ...options,
          selection: ["parallel", "tavily"],
        })
      ).provider,
    ).toBe("parallel");
    expect((await search.search("third", options)).provider).toBe("parallel");
    expect(exa.search).toHaveBeenCalledTimes(1);
    expect(parallel.search).toHaveBeenCalledTimes(2);
    expect(tavily.search).not.toHaveBeenCalled();
  });

  test("computes retry delay only from providers in the configured pool", async () => {
    const exa = provider("exa"),
      parallel = provider("parallel"),
      tavily = provider("tavily");
    exa.search.mockRejectedValue(limited("1"));
    tavily.search.mockRejectedValue(limited("10"));
    parallel.search.mockRejectedValue(limited("20"));
    const search = createSearch([exa, parallel, tavily], {
      now: () => 0,
      random: () => 0,
    });
    await expect(
      search.search("first", { ...options, selection: ["exa", "tavily"] }),
    ).rejects.toThrow("rate limited");
    await expect(
      search.search("second", {
        ...options,
        selection: ["parallel", "tavily"],
      }),
    ).rejects.toThrow("Try again in 10 seconds.");
    expect(exa.search).toHaveBeenCalledTimes(1);
  });

  test("a fixed provider still ignores cooldowns set by a pool", async () => {
    const exa = provider("exa"),
      tavily = provider("tavily");
    exa.search.mockRejectedValueOnce(limited());
    const search = createSearch([exa, tavily], { random: () => 0 });
    expect(
      (
        await search.search("first", {
          ...options,
          selection: ["exa", "tavily"],
        })
      ).provider,
    ).toBe("tavily");
    expect(
      (await search.search("second", { ...options, selection: "exa" }))
        .provider,
    ).toBe("exa");
  });

  test("none disables search without calling any provider", async () => {
    const exa = provider("exa"),
      tavily = provider("tavily");
    const search = createSearch([exa, tavily]);
    await expect(
      search.search("Pi", { ...options, selection: "none" }),
    ).rejects.toThrow("Web search is disabled");
    expect(exa.search).not.toHaveBeenCalled();
    expect(tavily.search).not.toHaveBeenCalled();
    await expect(
      search.search("Pi", {
        ...options,
        selection: "none",
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("reports unavailable pools instead of incorrectly reporting rate limits", async () => {
    const exa = provider("exa");
    const search = createSearch([exa]);
    await expect(
      search.search("Pi", { ...options, selection: ["tavily", "tinyfish"] }),
    ).rejects.toThrow("No enabled web search providers are available");
    await expect(
      search.search("Pi", { ...options, selection: [] }),
    ).rejects.toThrow("No enabled web search providers are available");
    await expect(
      search.search("Pi", { ...options, selection: "tavily" }),
    ).rejects.toThrow("Selected web search provider is unavailable");
    expect(exa.search).not.toHaveBeenCalled();
  });

  test("validates provider configuration without echoing arbitrary environment values", () => {
    expect(selectionFromEnv({})).toBe("auto");
    expect(selectionFromEnv({ PIX_WEBSEARCH_PROVIDER: " tavily " })).toBe(
      "tavily",
    );
    expect(() =>
      selectionFromEnv({ PIX_WEBSEARCH_PROVIDER: "secret" }),
    ).toThrow(/^PIX_WEBSEARCH_PROVIDER must be/);
  });
});
