# Contributing to @ikuma.cloud/mcp-web

Read the [repository contribution guide](../../CONTRIBUTING.md) before making
changes. Keep this package a thin MCP adapter; provider behavior and content
extraction belong to the existing web packages. Reserve stdout for protocol
traffic and never resolve arbitrary resource URIs to filesystem paths.

From the repository root:

```sh
mise run --silent mcp-web:build
mise run --silent test --project mcp-web
mise run --silent check
```

Tests exercise protocol discovery, both tools, provider pools and disabling,
rate-limit fallback, input errors, cancellation, bounded artifact recovery,
resource-read authorization, and legacy protocol negotiation through an in-memory
MCP client. CLI tests build all three packages and connect to the compiled server
over stdio, using a local HTTP fixture. No external services,
personal Pi configuration, or model requests are needed. Existing web-package
tests remain responsible for detailed provider and conversion behavior.

After changing distribution files, build first and inspect all packed artifacts:

```sh
mise exec -- pnpm --filter @ikuma.cloud/pix-webfetch pack --dry-run
mise exec -- pnpm --filter @ikuma.cloud/pix-websearch pack --dry-run
mise exec -- pnpm --filter @ikuma.cloud/mcp-web pack --dry-run
```

Both web packages expose a compiled `./core` entry point without Pi imports.
The `development` export condition points local TypeScript/Vitest validation to
source; production CLI builds use compiled declarations and JavaScript.
Pi peers are optional so standalone consumers do not install the Pi host.
Before publishing this server, publish both web packages with their compiled
core exports and remove this server's `private` flag.

Tool errors follow the
[MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling).
Resource links require MCP `2025-06-18` or newer, as documented in the
[protocol changelog](https://modelcontextprotocol.io/specification/2025-06-18/changelog).
Preserve text-based resource recovery for older negotiated versions.
