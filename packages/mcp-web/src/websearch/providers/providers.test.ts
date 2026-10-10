import { describe, expect, test, vi } from "vitest";
import { createHttp } from "../http.ts";
import { PROVIDER_IDS, type ProviderId } from "../types.ts";
import { createProviders } from "./index.ts";

const url = "https://example.com/docs";
const item = { url, title: "Documentation", content: "Useful documentation" };
const text = (value: string) => ({ content: [{ type: "text", text: value }] });
// Shapes verified against the keyless endpoints, including Exa's textual format.
const responses: Record<ProviderId, unknown> = {
  exa: text(
    `Title: ${item.title}\nURL: ${url}\nPublished: N/A\nAuthor: N/A\nHighlights:\n${item.content}`,
  ),
  parallel: {
    structuredContent: {
      results: [
        {
          url,
          title: item.title,
          publish_date: null,
          excerpts: [item.content],
        },
      ],
    },
  },
  firecrawl: text(
    JSON.stringify({
      success: true,
      data: { web: [{ url, title: item.title, description: item.content }] },
    }),
  ),
  tavily: { results: [item] },
  tinyfish: text(
    JSON.stringify({
      results: [{ url, title: item.title, snippet: item.content }],
    }),
  ),
};
const empty: Record<ProviderId, unknown> = {
  exa: text("No search results found. Please try a different query."),
  parallel: { structuredContent: { results: [] } },
  firecrawl: text('{"success":true,"data":{"web":[]}}'),
  tavily: { results: [] },
  tinyfish: text('{"results":[]}'),
};
const contracts = {
  exa: {
    endpoint: "https://mcp.exa.ai/mcp",
    tool: "web_search_exa",
    args: { query: "Pi", numResults: 8 },
    header: "x-api-key",
  },
  parallel: {
    endpoint: "https://search.parallel.ai/mcp",
    tool: "web_search",
    args: { objective: "Pi", search_queries: ["Pi"] },
    header: "Authorization",
  },
  firecrawl: {
    endpoint: "https://mcp.firecrawl.dev/v2/mcp",
    tool: "firecrawl_search",
    args: { query: "Pi", limit: 8 },
    header: "Authorization",
  },
  tavily: {
    endpoint: "https://api.tavily.com/search",
    tool: undefined,
    args: {
      query: "Pi",
      search_depth: "basic",
      chunks_per_source: 3,
      max_results: 8,
    },
    header: "Authorization",
  },
  tinyfish: {
    endpoint: "https://agent.tinyfish.ai/mcp",
    tool: "search",
    args: { query: "Pi" },
    header: "X-API-Key",
  },
};

function fixture(
  id: ProviderId,
  response = responses[id],
  env: NodeJS.ProcessEnv = {},
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return Response.json(
      id === "tavily"
        ? response
        : { jsonrpc: "2.0", id: body.id, result: response },
    );
  });
  const provider = createProviders(env, createHttp({ fetch })).find(
    (item) => item.id === id,
  );
  if (!provider) throw new Error("Missing test provider");
  return { provider, fetch };
}

describe.each(PROVIDER_IDS)("%s adapter", (id) => {
  test("sends the keyless request and normalizes results", async () => {
    const { provider, fetch } = fixture(id);
    expect(await provider.search("Pi")).toEqual([item]);
    const [endpoint, init] = fetch.mock.calls[0] ?? [];
    const contract = contracts[id];
    expect(endpoint).toBe(contract.endpoint);
    const body = JSON.parse(String(init?.body));
    expect(contract.tool ? body.params : body).toEqual(
      contract.tool
        ? { name: contract.tool, arguments: contract.args }
        : contract.args,
    );
    const headers = new Headers(init?.headers);
    expect(headers.has("Authorization")).toBe(false);
    expect(headers.has("X-API-Key")).toBe(false);
    if (id === "tavily") {
      expect(headers.get("X-Tavily-Access-Mode")).toBe("keyless");
      expect(headers.get("X-Client-Name")).toBe("pix-websearch");
    }
    if (id === "tinyfish")
      expect(headers.get("X-TinyFish-Access-Mode")).toBe("keyless");
  });

  test("uses an optional key without exposing it in the URL or results", async () => {
    const { provider, fetch } = fixture(id, responses[id], {
      [`${id.toUpperCase()}_API_KEY`]: " secret-key ",
    });
    const results = await provider.search("Pi");
    const [endpoint, init] = fetch.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get(contracts[id].header)).toBe(
      contracts[id].header === "Authorization"
        ? "Bearer secret-key"
        : "secret-key",
    );
    expect(headers.has("X-Tavily-Access-Mode")).toBe(false);
    expect(headers.has("X-TinyFish-Access-Mode")).toBe(false);
    expect(JSON.stringify({ endpoint, results })).not.toContain("secret-key");
  });

  test("accepts a valid empty result set", async () => {
    expect(await fixture(id, empty[id]).provider.search("Pi")).toEqual([]);
  });

  test("rejects malformed results rather than reporting no matches", async () => {
    await expect(
      fixture(id, text("broken upstream response")).provider.search("Pi"),
    ).rejects.toThrow();
  });
});

test("Exa parses multiple results, dates, and Text blocks", async () => {
  const first = `Title: Documentation\nURL: ${url}\nPublished: 2026-09-01\nText:\nFirst`;
  const second = `Title: N/A\nURL: https://example.com/other\nPublished: invalid\nHighlights:\nSecond`;
  const results = await fixture(
    "exa",
    text(`${first}\n\n---\n\n${second}`),
  ).provider.search("Pi");
  expect(results).toEqual([
    {
      url,
      title: "Documentation",
      content: "First",
      published: Date.parse("2026-09-01"),
    },
    { url: "https://example.com/other", content: "Second" },
  ]);
});

test("Parallel can decode JSON text when structuredContent is absent", async () => {
  const results = await fixture(
    "parallel",
    text(
      JSON.stringify({
        results: [
          {
            url,
            title: null,
            excerpts: ["First", "Second"],
            publish_date: "2026-09-01",
          },
        ],
      }),
    ),
  ).provider.search("Pi");
  expect(results).toEqual([
    { url, content: "First\n\nSecond", published: Date.parse("2026-09-01") },
  ]);
});

test("Firecrawl success:false is an error even with an empty result list", async () => {
  await expect(
    fixture(
      "firecrawl",
      text('{"success":false,"data":{"web":[]}}'),
    ).provider.search("Pi"),
  ).rejects.toThrow("Firecrawl search failed");
});

test("invalid result URLs fail validation", async () => {
  await expect(
    fixture("tavily", {
      results: [{ ...item, url: "not-a-url" }],
    }).provider.search("Pi"),
  ).rejects.toThrow("Invalid search result URL");
});
