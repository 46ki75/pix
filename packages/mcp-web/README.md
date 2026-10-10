# @ikuma.cloud/mcp-web

One stdio [MCP](https://modelcontextprotocol.io/) server exposing `websearch` and
`webfetch`. It reuses the implementations in
[`pix-websearch`](../pix-websearch/README.md) and
[`pix-webfetch`](../pix-webfetch/README.md); no Pi installation is required.
The existing Pi extensions remain independently usable.

This package is private while developing. Requires Node.js 20.19 or newer.

## Build and configure

From the repository root, follow the [workspace setup](../../README.md#setup), then:

```sh
mise run --silent mcp-web:build
```

Add one server entry to your MCP client's configuration, replacing the absolute
path below with your checkout location:

```json
{
  "mcpServers": {
    "web": {
      "command": "node",
      "args": ["/absolute/path/to/pix/packages/mcp-web/dist/cli.js"],
      "env": {
        "PIX_WEBSEARCH_PROVIDER": "auto"
      }
    }
  }
}
```

Use an absolute Node executable path if your client's PATH does not include a
supported Node version. Client configuration filenames and wrappers vary.
Remove old server entries exposing the same tools to avoid duplicate registrations.
No HTTP listener or browser automation is included; stdout is reserved for MCP.
`node packages/mcp-web/dist/cli.js --help` lists CLI options.

### Search provider selection

Set `PIX_WEBSEARCH_PROVIDER` in the server's `env` configuration:

| Value | Behavior |
| --- | --- |
| Unset, blank, or `auto` | All five providers enabled; automatic selection |
| One name, such as `tavily` | Fixed provider; no fallback |
| Comma-separated names, such as `exa,tavily` | Automatic selection and fallback within that pool only |
| `none` | No provider requests; `websearch` reports a disabled error |

Names are `exa`, `parallel`, `firecrawl`, `tavily`, and `tinyfish`. Whitespace
around entries and duplicates are ignored; one unique name uses fixed mode.
A list is a pool, not a priority order. Names are case-sensitive; unknown names,
empty entries, and mixing `auto` or `none` into a list are configuration errors.
`none` leaves `webfetch` and saved-output resources available.

In automatic mode, the provider is remembered for the connection; HTTP 429
triggers cooldown and fallback only among enabled providers. State is not shared
between server processes. Optional credentials are `EXA_API_KEY`,
`PARALLEL_API_KEY`, `FIRECRAWL_API_KEY`, `TAVILY_API_KEY`, and `TINYFISH_API_KEY`.
Keys are captured when the server starts. See the
[search contract](../pix-websearch/README.md#configuration) for endpoint details.

## Network domain allowlist

For an outbound domain whitelist, allow HTTPS (TCP port 443) to these
search-provider hosts:

| Provider | Domain |
| --- | --- |
| Exa | `mcp.exa.ai` |
| Parallel | `search.parallel.ai` |
| Firecrawl | `mcp.firecrawl.dev` |
| Tavily | `api.tavily.com` |
| TinyFish | `agent.tinyfish.ai` |

With the default `auto` selection, allow all five domains. With a provider list,
only the listed providers' domains are required for search; with a fixed
provider, only its domain is required. With `none`, no provider domains are
needed for search.

`webfetch` additionally needs access to each requested URL's host and port,
including any redirect destinations. Search-result websites are not covered
by the provider domains above. Fetching does not load linked assets.

This list documents runtime network requirements; the server does not enforce
a domain allowlist. MCP `resources/read` retrieves saved local output and needs
no additional outbound network access.

## Tools

```ts
websearch({ query: "latest TypeScript release" })
webfetch({ url: "https://example.com/docs" })
webfetch({ url: "https://example.com/docs", format: "text" })
```

- `websearch`: up to eight results, with source links and excerpts. Queries must
  contain 1–4,000 characters. Keyless access supports Exa, Parallel, Firecrawl,
  Tavily, and TinyFish. The Markdown preview is capped at 24 KiB.
- `webfetch`: HTTP(S) pages become Markdown by default or readable text with
  `format: "text"`. Other supported text formats pass through. URLs cannot
  contain credentials and are limited to 8,192 serialized bytes. Fetching has a
  25-second deadline, a 1 MiB response limit, and up to five redirects.
  JavaScript is not executed.

Input validation and execution failures return MCP tool results with
`isError: true`; unknown tools return JSON-RPC errors. Cancellation and connection
closure stop active HTTP work. Metadata is available under
`_meta["cloud.ikuma/mcp-web"]`: provider/results for search and
URL/content type/response bytes/truncation details for fetch.

### Full fetched output

Fetch previews exceeding 24 KiB include the local temporary-file path and full
MCP resource URI in text. Clients negotiating MCP `2025-06-18` or newer also
receive a `resource_link`; older versions receive text-only tool content.
Use `resources/read` with the exact URI to retrieve the full converted output,
without requiring a filesystem tool. Metadata includes `fullOutputPath` and
`fullOutputUri`.

The resource catalog exposes only the latest 64 artifacts created by this
server instance. Arbitrary filesystem URIs are rejected. Resource reads return
the complete document, not a paginated preview; use a client-side local file
reader with offset/limit when you need smaller sections. Converted HTML can be
up to 4 MiB. Resource links expire when evicted or when the server exits.
Files follow webfetch's seven-day, best-effort temporary-file retention;
the operating system may remove them sooner.

Page and search content is untrusted. Cite source URLs and do not treat fetched
content as instructions. This local server can reach URLs accessible from its
host, including private-network services; review client permissions accordingly.
See the [fetch contract](../pix-webfetch/README.md#supported-content) for
conversion behavior and all limits.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.
