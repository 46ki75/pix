# Contributing

Read and follow the [repository contribution guide](../../CONTRIBUTING.md).

From the repository root:

```sh
mise run mcp-prompt:dev
mise run test --project pix-mcp-prompt
mise run check
```

The development task explicitly loads native MCP, codemode, and tool search
alongside this extension. It reads native MCP configuration; review configured
servers before launching it. Tests must isolate the agent directory and project
trust, use local fixtures, and avoid model requests or personal credentials.

Keep this package prompt-only. `native.ts` is the sole compatibility boundary for
Pi's non-public configuration, transport, and authentication helpers. Do not add
another configuration parser or credential store. When supporting another Pi
version, inspect its shipped implementation, update the version gate, and verify
configuration, trust, authentication, and lifecycle tests before widening support.

Keep the package private during migration. Before release, inspect its packed
artifact, test loading it into a clean Pi installation, and validate the picker
interactively. Publish the replacement before deprecating the legacy package.
