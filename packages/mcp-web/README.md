# @ikuma.cloud/mcp-web

One stdio [MCP](https://modelcontextprotocol.io/) server exposing `websearch` and
`webfetch`. Search providers, page conversion, and artifact storage are owned by
this package; neither Pi nor the Pi web-extension packages are required to build,
install, or run it. The existing Pi extensions remain independently usable.

Requires Node.js 20.19 or newer.

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
triggers cooldown and fallback only among enabled providers. Each provider is
attempted at most once per call. `Retry-After` seconds and HTTP dates are supported;
missing or invalid values use 60 seconds. If all enabled providers are cooling
down, search fails immediately. Other failures are reported without fallback.
Fixed mode reports errors directly and bypasses automatic cooldowns. State is
not shared between server processes.

Optional credentials are captured when the server starts:

| Provider | API-key environment variable | Endpoint |
| --- | --- | --- |
| Exa | `EXA_API_KEY` | `https://mcp.exa.ai/mcp` |
| Parallel | `PARALLEL_API_KEY` | `https://search.parallel.ai/mcp` |
| Firecrawl | `FIRECRAWL_API_KEY` | `https://mcp.firecrawl.dev/v2/mcp` |
| Tavily | `TAVILY_API_KEY` | `https://api.tavily.com/search` |
| TinyFish | `TINYFISH_API_KEY` | `https://agent.tinyfish.ai/mcp` |

Keys are sent only in request headers; empty keys select keyless access. Tavily
uses `X-Tavily-Access-Mode: keyless`; TinyFish uses `X-TinyFish-Access-Mode: keyless`.
Keyless services are rate limited. TinyFish's keyless header is used by OpenCode
v2 and was verified live on September 23, 2026, but was not described in its
public MCP guide at that date.

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

### Proxies

Proxy environment variables are not enabled by default. On Node.js 24, set
`NODE_USE_ENV_PROXY=1` in the MCP server's `env` alongside `HTTP_PROXY` and/or
`HTTPS_PROXY`; use `NO_PROXY` for bypasses. These settings must be present when
Node starts. Both tools use this native behavior, with no custom proxy handling.
See [Node's proxy documentation](https://nodejs.org/docs/latest-v24.x/api/cli.html#node_use_env_proxy1).

## Tools

```ts
websearch({ query: "latest TypeScript release" })
webfetch({ url: "https://example.com/docs" })
webfetch({ url: "https://example.com/docs", format: "text" })
```

- `websearch`: up to eight results, with source links and excerpts. Queries must
  contain 1–4,000 characters. Keyless access supports Exa, Parallel, Firecrawl,
  Tavily, and TinyFish. The Markdown preview is capped at 24 KiB, with excerpts
  capped at 2,000 UTF-8 bytes each. Each provider request has a 25-second deadline
  and a 256 KiB response limit.
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

### Supported fetched content

- HTML and XHTML are parsed with `htmlparser2`, cleaned, and converted by a local
  Markdown serializer. Headings, links, lists, quotes, code, and GFM tables are
  retained. Structures Markdown cannot faithfully represent remain HTML, including
  irregular or merged-cell tables and complex nested inline markup.
- Text mode uses `html-to-text` with readable headings, lists, code, and table-cell
  separators. Both modes resolve relative links against the final response URL
  and omit scripts, styles, navigation, footers, forms, hidden elements, and
  embedded resources.
- Markdown requests prefer server-provided `text/markdown`; text mode prefers
  `text/plain`. Plain text, Markdown, JSON, XML, YAML, JavaScript, other `text/*`
  types, and JSON/XML-suffixed application types pass through as text.
- HTTP charset declarations are honored, defaulting to UTF-8. Missing content
  types are treated as plain text. Unsupported types/encodings and NUL-containing
  content fail. No browser cookies, linked assets, or JavaScript are used, so
  client-rendered pages may contain little readable text.

| Fetch limit | Value |
| --- | --- |
| URL | HTTP(S), no embedded credentials, up to 8,192 serialized bytes |
| Redirects | Five, with loop detection and URL validation at each hop |
| Network deadline | 25 seconds total, including redirects and body reads |
| Response body | 1 MiB of decompressed bytes |
| Prepared HTML / converted HTML output | 4 MiB each, including resolved links |
| Preview | 24 KiB, including metadata and recovery instructions |
| HTML traversal depth | 100; deeper content becomes an omission marker |
| HTML attributes | Up to 256 per retained element; excess fails conversion |

Oversized responses and conversions fail rather than silently returning partial
content. Preview truncation preserves UTF-8 characters and prefers complete lines.
Cancellation stops active body reads and further redirects.

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
Files retain the legacy `pix-webfetch` directory under the operating system's
temporary directory, with seven-day, best-effort retention; the operating system
may remove them sooner. Saved output includes the same filtering and depth limit
as the preview, not the raw page.

Page and search content is untrusted. Cite source URLs and do not treat fetched
content as instructions. This local server can reach URLs accessible from its
host, including private-network services; review client permissions accordingly.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.
