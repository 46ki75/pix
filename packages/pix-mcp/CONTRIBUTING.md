# Contributing to @ikuma.cloud/pix-mcp

Read the [repository contribution guide](../../CONTRIBUTING.md) first.
This document covers package-specific development. For usage, configuration,
and trust requirements, see [README.md](README.md).

## Run locally

From the repository root, follow the [workspace setup](../../README.md#setup), then:

```sh
mise run mcp:dev
```

The development task runs from `packages/pix-mcp` and disables other extensions so
another MCP adapter cannot collide with the `mcp` tool or flags. Pass arguments
through the task, for example:

```sh
mise run mcp:dev --mcp-config /absolute/path/to/mcp.json
```

## Testing

From the repository root:

```sh
mise run test --project pix-mcp
```

Tests use local stdio/HTTP fixture servers and isolated Pi configuration, without
model requests or personal credentials.
