# @ikuma.cloud/pix-mcp-prompt

User-selected MCP prompts alongside Pi's native tools and resources.
**Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.**

This version supports **Pi 1.0.0, 1.0.2, and 1.1.0**.

## Installation

```sh
pi install npm:@ikuma.cloud/pix-mcp-prompt
```

To load it from this checkout instead:

```sh
pi -e /absolute/path/to/pix/packages/pix-mcp-prompt
```

Remove `pix-mcp` from that session to avoid duplicate `/mcp-prompt` commands. Keep
Pi's built-in MCP extension enabled. Tools, resources, `/mcp`, authentication,
and permissions remain Pi's responsibility.

## Configuration

Use [Pi's native MCP configuration](https://pi.dev/docs/latest/mcp):

- `<agent-dir>/mcp.json` (normally `~/.pi/agent/mcp.json`).
- `.pi/mcp.json` in the session directory, only when Pi grants project trust.

There is no prompt-specific configuration file or flag. Bare `.mcp.json` is not
read. The extension uses Pi's shipped configuration loader, transport factory,
and authentication helpers rather than implementing another configuration format.
Registered extension servers are also considered; file definitions take
precedence, including names differing only in `-` and `_`. On Pi 1.0.2 and 1.1.0,
project entries containing only `enabled`, `exposure`, or `toolExposure` override a
global server without replacing its transport or credentials.

For example, after installing `@ikuma.cloud/mcp-copilot-prompts`, add this to
`.pi/mcp.json` and approve the project:

```json
{
  "mcpServers": {
    "copilot-prompts": {
      "command": "mcp-copilot-prompts",
      "args": ["--root", "."]
    }
  }
}
```

Native behavior applies: `enabled: false` prevents connections, `timeout` is in
seconds (default 60, reset by progress), relative `cwd` resolves from the session
directory, and stdio inherits Pi's environment. `env`/`headers` use Pi's `${VAR}`
and whole-value `!command` resolution. Review configuration before trusting it:
it can execute programs and contact remote services.

Sign in with native `/mcp` or `pi mcp login`. Prompt connections use the same
`mcp-auth.json` and refresh locks. OAuth accounts are keyed by server name and
URL, including Pi's migration of legacy URL-only credentials. The native
`oauth.authServerMetadataUrl` override also applies to prompt token refreshes.
Provider authentication uses Pi's provider credentials; project configuration
cannot request provider authentication. On Pi 1.0.2 and 1.1.0, prompt token
refreshes also honor `oauth.clientRegistration` (`dcr` or `cimd`).
Embedded SDK hosts should set `PI_CODING_AGENT_DIR` as well as their SDK
`agentDir`, matching the native MCP extension's use of `getAgentDir()`.

## Commands

```text
/mcp-prompt
/mcp-prompt list [server]
/mcp-prompt run <server> <prompt> [name=value ...]
```

In the TUI, the bare command opens the picker, collects arguments, and places the
rendered prompt in the editor for review. Escape cancels. Required and optional
arguments appear in declaration order; an empty optional input is omitted.

`run` submits immediately (or queues a follow-up while Pi is working). It accepts
positional arguments and shell-style quoted `name=value` arguments; `name=` passes
an intentional empty string. `list` reports catalogs and connection status. In
print/JSON mode, command errors carry the listing because there is no UI result
channel. RPC supports explicit `list` and `run`, not the terminal picker.

Prompt bodies are retrieved only on user selection, never exposed as tools or
automatically added to model context. Completion uses locally discovered names
and arguments; MCP `completion/complete` is not implemented.

## Connections and compatibility

None of the supported Pi versions expose their connected MCP clients. This
extension therefore opens **a separate connection**, including a second process
for stdio servers. It waits until the first prompt command to do so; native Pi
may already have connected the same servers at startup. Prompt discovery never
requests tools or resource catalogs. Catalog list-change notifications invalidate
stale selections.

Native file and registration changes are reconciled on prompt commands and
agent turns. A disabled or replaced connection is closed. Native `/mcp reconnect`
and session-only `/mcp` overrides of extension registrations are not shared with
the prompt client; use `/reload` to reset both implementations. A disconnected
prompt client reconnects when next needed.

Native configuration and authentication helpers are shipped but not public
exports. `src/native.ts` isolates their use and **accepts only Pi 1.0.0, 1.0.2,
and 1.1.0** rather than silently changing trust or credential behavior. Other
versions, including unverified patch releases, require explicit compatibility
validation. This is not a shared-client API or a claim of upstream support.

## Content and safety

Text, supported images, and embedded text/image resources retain their order.
Multi-message prompts are flattened with `[user]`/`[assistant]` markers rather
than injected as privileged conversation roles. Resource links remain text and
are never fetched automatically. Leading command-like editor text is guarded
against slash-command or shell dispatch; direct submissions disable template
expansion.

Previews are limited to 24 KiB and 1000 text lines and four PNG/JPEG/GIF/WebP
images of at most 4 MiB each. Unsupported or truncated content is retained in a
private temporary JSON artifact. Editor images are private temporary files.
These artifacts are removed on session shutdown/reload; they are not durable
attachments for resumed sessions. They may contain sensitive server data.

Prompt metadata, pagination, arguments, and responses are bounded and validated.
Transport framing and request cancellation use Pi's MCP library. Limits are not
a sandbox: server content and local executables remain untrusted.

## Migrating from pix-mcp

1. Upgrade Pi to a supported version listed above. Keep the legacy installation
   available for rollback until the replacement is validated for your servers.
   Never load both extensions in one session.
2. Move project entries from `.mcp.json` to `.pi/mcp.json` and grant project trust.
3. Convert `disabled: true` to `enabled: false`; convert `timeout` from
   milliseconds to seconds. Remove `startupTimeoutMs` and `catalogTimeoutMs`.
4. Adjust `cwd` for session-relative resolution. Pi expands environment/command
   values in `env` and `headers`, not arbitrary `command`/`args`/`url` strings;
   `~` expansion in stdio paths is supported. Replace `${VAR:-default}`.
5. Remove legacy `--mcp-config` launch flags and enable Pi's built-in MCP
   extension, removing any `-builtin:mcp` setting or `--no-mcp` launch flag.
   Use native `/mcp`, `codemode`, `tool_search`, and the native resource tools
   instead of the old `mcp` tool or `/mcp-resource` picker. Tool names and schema
   handling now belong to Pi.
6. Remove the legacy package with `pi remove npm:@ikuma.cloud/pix-mcp`, then
   install this package as shown above if you need prompts. Add `--local` to
   package commands for project installations; remove any legacy path-based
   extension settings or `-e` arguments separately. Run `pi mcp list` to verify
   native connections and `/mcp-prompt list` to verify prompts.

Invalid project entries are handled exactly as native Pi handles them, which can
leave a valid global entry effective; the legacy adapter masked that global
entry. Review configurations rather than copying legacy fields unchanged.

`@ikuma.cloud/pix-mcp` is deprecated. Existing versions remain installable for
compatibility and rollback; they will not be unpublished.
