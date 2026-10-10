# @ikuma.cloud/pix-websearch

A native [Pi Coding Agent](https://pi.dev/) `websearch` tool backed by Exa,
Parallel, Firecrawl, Tavily, and TinyFish. Keyless access works without account
setup; optional API keys use the corresponding provider account's limits.

## Usage

To load this package in an existing Pi installation, use its absolute path:

```sh
pi -e /absolute/path/to/pix/packages/pix-websearch
```

Pi loads the package's TypeScript source directly; no build step is needed.

Ask Pi to search for something, for example:

```text
Search for the latest TypeScript release and summarize the changes with sources.
```

For other MCP clients, [`@ikuma.cloud/mcp-web`](../mcp-web/README.md) exposes
this tool and `webfetch` through a single standalone stdio server.

## Configuration

`PIX_WEBSEARCH_PROVIDER` controls which providers can receive search requests:

| Value | Behavior |
| --- | --- |
| Unset, blank, or `auto` | All five providers enabled; automatic selection |
| One name, such as `tavily` | Fixed provider; no fallback |
| Comma-separated names, such as `exa,tavily` | Automatic selection and fallback within that pool only |
| `none` | No provider requests; search calls report a disabled error |

Provider names are `exa`, `parallel`, `firecrawl`, `tavily`, and `tinyfish`.
Names are case-sensitive. Whitespace around entries and duplicate names are
ignored; one unique name uses fixed-provider mode. Lists are pools, not priority
orders. Unknown names, empty entries, and mixing `auto` or `none` into a list
are configuration errors.

For example, enable only Exa and Tavily:

```sh
PIX_WEBSEARCH_PROVIDER=exa,tavily pi -e /absolute/path/to/pix/packages/pix-websearch
```

The same setting works in the standalone MCP server. `none` leaves the tool
registered but disables provider requests; it does not affect `webfetch`.

Optional credentials are read when Pi loads the extension:

| Provider | API-key environment variable | Keyless endpoint |
| --- | --- | --- |
| Exa | `EXA_API_KEY` | `https://mcp.exa.ai/mcp` |
| Parallel | `PARALLEL_API_KEY` | `https://search.parallel.ai/mcp` |
| Firecrawl | `FIRECRAWL_API_KEY` | `https://mcp.firecrawl.dev/v2/mcp` |
| Tavily | `TAVILY_API_KEY` | `https://api.tavily.com/search` |
| TinyFish | `TINYFISH_API_KEY` | `https://agent.tinyfish.ai/mcp` |

Keys are sent only in request headers. An empty key selects keyless access.
Tavily uses `X-Tavily-Access-Mode: keyless`; TinyFish uses
`X-TinyFish-Access-Mode: keyless`. Requests identify this package as
`pix-websearch`, not OpenCode.

Keyless services are rate limited. TinyFish's keyless header is used by OpenCode
v2 and was verified live on September 23, 2026, but is not described in TinyFish's
public MCP guide at that date.

### Automatic selection

Automatic mode (`auto` or a provider list) randomly selects an available enabled
provider and keeps it for the Pi session. HTTP 429 puts that provider in cooldown
and retries another enabled provider. Providers outside the configured pool are
never selected or used for fallback. Each enabled provider is attempted at most
once per call. `Retry-After` seconds and HTTP dates
are supported; missing or invalid values use 60 seconds.

Cooldowns live in memory in this extension instance and apply across sessions
in the same Pi process. Session start/shutdown clears the remembered selection;
reloading the extension clears all state. Separate Pi processes do not share
cooldowns. If all enabled providers are cooling down, the call fails immediately.

Fixed-provider mode reports errors directly. Automatic mode also reports
authentication, network, parsing, and other non-429 failures directly.

## Tool contract

```ts
websearch({ query: string })
```

- Queries must contain 1–4,000 characters after trimming.
- Up to eight results include URLs, titles, excerpts, and publication dates when
  available. Providers differ in coverage and excerpt depth.
- Model-facing output is Markdown, capped at 24 KiB with excerpts capped at
  2,000 UTF-8 bytes each. Shortened output points to the source URLs.
- Pi tool-result `details` retains the provider and the normalized results.
- Every request has a 25-second timeout and a 256 KiB response limit. A call may
  try up to five providers after rate limits. Pi cancellation stops further work.
- The tool works in interactive and headless modes.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.
