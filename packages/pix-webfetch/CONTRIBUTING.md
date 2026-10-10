# Contributing to @ikuma.cloud/pix-webfetch

Read the [repository contribution guide](../../CONTRIBUTING.md) first.
This document covers package-specific development. For usage and the tool
contract, see [README.md](README.md).

## Run locally

From the repository root, follow the [workspace setup](../../README.md#setup), then:

```sh
mise run webfetch:dev
```

To launch Pi with both web search and web fetch:

```sh
mise run web:dev
```

The Pi extension still loads source without a build. The standalone MCP server
uses the Pi-independent `./core` export; build it with
`mise run --silent webfetch:build`. Package packing builds and includes this core.

## Testing

From the repository root:

```sh
mise run test --project pix-webfetch
```

Tests cover HTTP negotiation, redirects, cancellation, timeouts, character
decoding, Markdown/text extraction, table rendering, conversion performance,
output limits, artifact persistence, and retention. A local HTTP server checks
native fetch's decompression behavior.
Pi-loader integration tests exercise both output formats, loading alongside
websearch, and reading later sections from an overflow artifact through Pi's
real `read` tool, without model calls or external network access.
