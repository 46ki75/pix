# Contributing to @ikuma.cloud/pix-websearch

Read the [repository contribution guide](../../CONTRIBUTING.md) first.
This document covers package-specific development. For usage, configuration,
and the tool contract, see [README.md](README.md).

## Run locally

From the repository root, follow the [workspace setup](../../README.md#setup), then:

```sh
mise run websearch:dev
```

To try a fixed provider:

```sh
PIX_WEBSEARCH_PROVIDER=tavily mise run websearch:dev
```

## Testing

From the repository root:

```sh
mise run test --project pix-websearch
```

Tests mock HTTP and isolate Pi discovery from personal configuration. They cover
provider request/response contracts, JSON and SSE handling, bounded response
reads, cancellation, rate-limit fallback, output limits, and Pi package loading.

## Implementation references

The endpoint contracts and selection behavior were researched from
[OpenCode v2 at `1746672`](https://github.com/anomalyco/opencode/tree/1746672c4229527106c9db39d25c34adbe834230/packages/core/src/plugin/websearch)
and the provider documentation:
[Exa](https://exa.ai/docs/reference/exa-mcp),
[Parallel](https://docs.parallel.ai/integrations/mcp/search-mcp),
[Firecrawl](https://docs.firecrawl.dev/mcp-server/keyless),
[Tavily](https://docs.tavily.com/documentation/keyless), and
[TinyFish](https://docs.tinyfish.ai/mcp-integration/index).

The MCP adapters make endpoint-specific `tools/call` POSTs and accept JSON or SSE.
These endpoints accept calls without initialization; this transport is not a
general-purpose MCP client. The implementation uses native `fetch` and no search
provider SDKs.
