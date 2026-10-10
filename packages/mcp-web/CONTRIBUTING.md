# Contributing to @ikuma.cloud/mcp-web

Read the [repository contribution guide](../../CONTRIBUTING.md) before making
changes. This package owns its implementations in `src/websearch/` and
`src/webfetch/`; keep `src/server.ts` focused on the MCP adapter. Do not add
build, runtime, or test dependencies on Pi or sibling web-extension packages.
Reserve stdout for protocol traffic and never resolve arbitrary resource URIs
to filesystem paths.

From the repository root:

```sh
mise run --silent mcp-web:build
mise run --silent test --project mcp-web
mise run --silent check
```

The web implementations and unit tests were copied from the Pi extensions so
those packages can be removed independently. Preserve existing environment
variables, outbound request identification, and temporary-file paths for
compatibility; the legacy `pix-websearch`/`pix-webfetch` strings are not package
imports. Future changes and regression tests belong here, not in sibling cores.

## Testing and distribution

Package-local tests cover provider contracts, selection pools, disabling,
JSON/SSE handling, HTTP negotiation, redirects, cancellation, output limits,
Markdown/text conversion, performance bounds, and artifact persistence/retention.
Markdown round-trip tests use `marked` directly, without a Pi renderer dependency.

Protocol tests exercise both tools, fallback, errors, bounded artifact recovery,
resource authorization, and legacy protocol negotiation with an in-memory client.
CLI tests build this package alone and connect over stdio using a local HTTP
fixture. The distribution regression test rejects Pi/workspace dependencies and
builds an isolated source copy with only declared external dependencies and the
shared TypeScript tooling. No external services, personal Pi configuration, or
model requests are needed.

After changing distribution files, build and inspect the packed artifact:

```sh
mise exec -- pnpm --filter @ikuma.cloud/mcp-web pack --dry-run
```

Also install a tarball outside the workspace and exercise both tools before
publishing. This server no longer requires publishing any sibling packages.
Keep its `private` flag during development.

## Implementation references

Provider contracts originated from
[OpenCode v2 at `1746672`](https://github.com/anomalyco/opencode/tree/1746672c4229527106c9db39d25c34adbe834230/packages/core/src/plugin/websearch)
and the provider documentation:
[Exa](https://exa.ai/docs/reference/exa-mcp),
[Parallel](https://docs.parallel.ai/integrations/mcp/search-mcp),
[Firecrawl](https://docs.firecrawl.dev/mcp-server/keyless),
[Tavily](https://docs.tavily.com/documentation/keyless), and
[TinyFish](https://docs.tinyfish.ai/mcp-integration/index).
The adapters issue endpoint-specific `tools/call` POSTs and accept JSON or SSE;
they are not general MCP clients and use no provider SDKs.

Tool errors follow the
[MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling).
Resource links require MCP `2025-06-18` or newer, as documented in the
[protocol changelog](https://modelcontextprotocol.io/specification/2025-06-18/changelog).
Preserve text-based resource recovery for older negotiated versions.
