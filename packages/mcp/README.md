# @ikuma.cloud/pix-mcp

A small Pi MCP adapter: discover tools, load their schemas on demand, then call
those tools natively. No scripting engine or model-provider-specific API is
required.

**Read [CONTRIBUTING.md](../../CONTRIBUTING.md) before making changes.**

## Development

From the repository root:

```sh
mise run mcp:dev
mise run test --project pix-mcp
mise run check
```

The development task runs from `packages/mcp` and disables other extensions so
another MCP adapter cannot collide with the `mcp` tool or flags. Pass arguments
through the task, for example:

```sh
mise run mcp:dev --mcp-config /absolute/path/to/mcp.json
```

For an existing Pi installation, load this package with
`pi --no-extensions -e /absolute/path/to/pix/packages/mcp`.

## Configuration and trust

By default, read only `.mcp.json` in Pi's working directory. There is no ancestor
search, global config merge, automatic import, or persistent metadata cache.
Relative `--mcp-config` paths resolve from that working directory; a stdio
server's `cwd` resolves from the config directory and defaults to that directory.

A bare `.mcp.json` is not protected by Pi's project-trust mechanism. This adapter
asks before using the default file. In a headless session, it remains disabled
unless explicitly trusted. Either of these authorizes the file for one session:

- `--mcp-config <path>`: select **and trust** a file.
- `--mcp-trust-config`: trust the default `.mcp.json`.

Review the file first: trusting it can launch arbitrary local programs and
contact remote services. Configuration trust is not an OS sandbox.

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["server.js"],
      "cwd": "./service",
      "env": { "SERVICE_TOKEN": "${SERVICE_TOKEN}" },
      "description": "Local project documentation tools"
    },
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${SERVICE_TOKEN}" },
      "description": "Issue tracking tools",
      "timeout": 960000,
      "startupTimeoutMs": 30000,
      "catalogTimeoutMs": 30000,
      "approve": true
    }
  }
}
```

### Supported configuration

MCP standardizes the protocol, not a universal configuration file. This adapter
supports a [Claude Code-style](https://code.claude.com/docs/en/mcp) connection
subset, not every client-specific field or transport. OpenCode configuration,
Cursor's `${env:VAR}` syntax, and other clients' approval policies are not imported
or translated.

The published [JSON Schema](mcp.schema.json) provides editor validation. An
optional root `$schema` string can reference your installed copy; the adapter
never fetches that URL. Runtime validation additionally checks expanded strings,
URLs, and HTTP headers.

| Field | Behavior |
| --- | --- |
| `type` | `stdio`, `http`, or `streamable-http` (alias of `http`); only stdio is inferred, when `command` is present |
| `command`, `args`, `env` | Stdio only; executable and argument array, not a shell command |
| `url`, `headers` | Streamable HTTP only; explicit `type` required; no legacy SSE fallback or redirect following |
| `timeout` | Hard deadline for each tool invocation, in milliseconds; default 30000 |
| `cwd` | Stdio extension: working directory relative to the config directory |
| `description` | Discovery extension: optional summary, truncated to 500 characters |
| `startupTimeoutMs` | pix extension: complete connection/initialization handshake deadline; default 30000 |
| `catalogTimeoutMs` | pix extension: complete catalog snapshot deadline, including all pages; default 30000 |
| `approve` | pix policy: require confirmation for every invocation, default `true` |
| `disabled` | Skip the server's value validation and environment expansion when `true`; unknown fields are still errors |

`command`, `args`, `cwd`, `env` values, `url`, and `headers` values expand `${VAR}`
and `${VAR:-default}`. A default applies only when the variable is unset, not when
it is an empty string. Expansion is single-pass against Pi's environment; `env`
entries do not define variables for other entries. Missing variables and invalid
expanded values fail without echoing credentials. Stdio inherits the SDK's
minimal platform environment plus explicit `env`, not the entire Pi environment.
Credentials and fragments in HTTP URLs are rejected; use headers for credentials.
Unknown fields fail rather than silently accepting unsupported configuration.

### Deadlines and migration

All three deadline fields accept integers from 1 through 2,147,483,647 milliseconds
(Node's timer-safe maximum). Each defaults independently to 30 seconds. Setting
`"timeout": 960000` permits a 16-minute tool call without lengthening startup or
discovery. The call clock starts after invocation approval and connection startup;
progress does not reset it. Catalog deadlines cover all pages of one snapshot;
a subsequent list-change refresh starts a new deadline.

HTTP deadlines cover response headers and bodies, including JSON and SSE. MCP
requests borrow the host's HTTP/proxy routing but override its header/body idle
limits per request; Pi's global settings and unrelated requests are unchanged.
Notification GET streams have a bounded header wait but no body-idle deadline.
Upstream proxies and servers may still impose their own limits.

**Breaking changes from 0.0.1:**

- Replace `timeoutMs` with `timeout` for tool calls. Set `startupTimeoutMs` and
  `catalogTimeoutMs` separately if their defaults are unsuitable. The removed
  field produces a migration diagnostic; it is not an alias.
- Add `"type": "http"` to remote entries that previously specified only `url`.
- Connection strings now expand environment references beyond `env` and `headers`.

The 120-second call ceiling is removed. This is a configuration migration, not a
promise to finish a remote operation within its deadline.

### Invocation approval

Tool invocation requires confirmation independently of config trust. In headless
mode, calls fail closed unless the reviewed configuration explicitly sets
`"approve": false` for that server. Native calls still pass through Pi's normal
tool hooks. Server annotations never grant permission. Child stderr and raw SDK
errors are not printed because they can contain credentials; debug a failing
server separately in a trusted environment.

## Discovery and execution

At session startup, the adapter connects to trusted servers and fetches their
paginated tool catalogs. One failure does not hide tools from other servers.
Full schemas stay out of model context until selected. **Schema exposure is lazy;
initial connections and metadata discovery are not.**

The agent uses the `mcp` tool:

```js
mcp({ action: "list", server: "local", limit: 20, offset: 0 })
mcp({ action: "search", query: "documentation", limit: 5 })
mcp({ action: "load", names: ["exact_name_from_discovery"] })
```

`list` returns paginated summaries without loading tools. `search` uses local,
deterministic name/description matching and activates up to 10 matches. `load`
activates up to 10 exact names. A result's `active` field reports whether Pi
allowed activation. No separate describe call is required: the full tool schema
is available on the next model request. Loading never executes the tool.
Selection is tied to the current schema fingerprint: use `search`/`load`, not
Pi's generic tool-name toggles, to enable a native MCP tool.

Native names include a readable server/tool prefix and a deterministic hash to
avoid normalization collisions. Independent, preapproved native calls can run
concurrently. Calls requiring confirmation run sequentially to avoid overlapping
approval dialogs. Discovered tools stay active until session shutdown or a server
catalog change.
Changed and removed definitions are withdrawn; changed tools require loading
again. Unsupported input schemas or metadata, name collisions, and task-only
tools are counted as `unsupportedTools` in discovery results. An unsupported
output schema fails that server's discovery. Losing an established HTTP
notification stream also withdraws tools rather than silently keeping a stale
catalog; servers that decline the optional stream with HTTP 405 remain usable.
Reload Pi to reconnect a failed server or reread configuration.

Pi handles provider compatibility. Some providers support transcript-anchored
schema additions; others rebuild the tool set and may invalidate prompt caches.
For very small catalogs, eager loading would avoid a discovery round trip, but
v1 intentionally offers only the deferred mode.

## Output and limits

Text, supported images, and structured content are retained. Long text gets a
24 KiB / 1000-line preview; structured details are bounded to 16 KiB. At most four
PNG/JPEG/GIF/WebP images of up to 4 MiB each are shown. Unsupported or oversized
content is explicitly omitted from the preview, not silently discarded. Pi's
error-result path is text-only, so images in MCP errors are preserved in a
full-result artifact rather than displayed inline.

When necessary, the full MCP result is written to `pix-mcp-*/result.json` under
the system temp directory (directory mode 0700, file mode 0600). Pi can inspect it
with `read`. These artifacts may contain sensitive data and are **not deleted at
session shutdown**; remove them when no longer needed. Output limits are not a
complete memory or security sandbox.

Configuration is limited to 256 KiB and 32 servers. Startup connects at most four
servers concurrently. Each catalog is limited to 1000 tools, 100 pagination
cursors, and 2 MiB of metadata; individual input/output schemas are limited to
64 KiB. Tool names must use 1–128 ASCII letters, digits, underscores, hyphens, or
periods; descriptions are limited to 16 KiB. Stdio messages are limited to 16 MiB.
Schemas are syntax-checked before compilation. Only the default MCP dialect,
JSON Schema 2020-12, is supported; explicit legacy dialects (including embedded
resources) are rejected rather than interpreted with incorrect reference
semantics. External schema references are unsupported, but literal `$ref` fields
inside instance data are allowed.

The adapter never automatically retries `tools/call`: a timeout or lost response
may occur after a mutating operation took effect. Cancellation or expiration
aborts only the affected HTTP request and sends a best-effort MCP cancellation
notification; concurrent sibling calls remain usable. Successful output is
validated against the schema captured when the call began; MCP error results are exempt
from that success schema. Cancellation is best-effort at the server and does not
roll back effects.

## Deliberately out of scope

OAuth, legacy SSE transport, MCP prompts/resources APIs, sampling, elicitation,
MCP apps, task execution, semantic search, scripting, config UI, and persistent
catalog caching. Use a fuller adapter when those capabilities are required.

Tests use local stdio/HTTP fixture servers and isolated Pi configuration, without
model requests or personal credentials.
