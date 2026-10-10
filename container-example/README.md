# Container example

Read [CONTRIBUTING.md](../CONTRIBUTING.md) before making changes.

> **Legacy example.** This image pins Pi 0.87.1 and installs the deprecated
> `pix-webfetch`, `pix-websearch`, and `pix-mcp` packages. For new setups, use
> [`mcp-web`](../packages/mcp-web/README.md), native Pi MCP, and
> [`pix-mcp-prompt`](../packages/pix-mcp-prompt/README.md) when you need prompts.

Using Apple's `container` CLI, build the image from the repository root with the
[example Dockerfile](Dockerfile):

```sh
container build -t pi ./container-example
```

Run Pi interactively as `vscode`, forwarding your terminal settings for color
support. The container is removed when Pi exits.

```sh
container run -it --rm -e TERM -e COLORTERM pi
```

Without a persistent mount, changes made inside the container are lost when it
is removed.

## Migrating the legacy image

The settings disable built-in MCP to prevent duplicate connections with the
legacy adapter. Existing package versions remain installable, but the image has
not been migrated or validated with the replacements.

To migrate, first update the Dockerfile to a Pi version supported by
[`pix-mcp-prompt`](../packages/pix-mcp-prompt/README.md). Replace the `pix-mcp`
package entry with `pix-mcp-prompt`, remove `-builtin:mcp`, and migrate server
entries using its [migration guide](../packages/pix-mcp-prompt/README.md#migrating-from-pix-mcp).
Replace the two Pi web extensions with an npm-installed `mcp-web` CLI and a
native MCP server entry as described in its [Pi migration guide](../packages/mcp-web/README.md#pi-migration).
Build and test the resulting image before adopting it; do not load the legacy
adapters alongside their replacements.

## Codex credentials

After signing into Codex through Pi's `/login` command on the host, mount Pi's
credential file at runtime:

```sh
container run -it --rm \
  -e TERM -e COLORTERM \
  -v "$HOME/.pi/agent/auth.json:/home/vscode/.pi/agent/auth.json" \
  pi
```

The mount is read-write by default. Keep it writable so Pi can save refreshed
OAuth tokens back to the host file; do not add `:ro`.

- The container can read and modify every credential in this file, not just Codex.
  Prefer a dedicated Codex-only auth file for narrower access.
- Avoid simultaneous host/container use of the same OAuth credentials because
  token refreshes can conflict.
- Never commit credentials or copy them into the image.
