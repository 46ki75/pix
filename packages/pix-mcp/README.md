# @ikuma.cloud/pix-mcp

A small Pi MCP adapter: discover tools, load their schemas on demand, then call
those tools natively. No scripting engine or model-provider-specific API is
required.

## Usage

To load this package in an existing Pi installation:

```sh
pi -e /absolute/path/to/pix/packages/pix-mcp
```

Disable any other MCP adapter that would collide with the `mcp` tool or flags,
but keep any permission-control extensions enabled. Review the configuration
and trust requirements below before connecting servers.

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
      "catalogTimeoutMs": 30000
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
| `disabled` | Skip the server's value validation and environment expansion when `true`; unknown fields are still errors |

`command`, `args`, `cwd`, `env` values, `url`, and `headers` values expand `${VAR}`
and `${VAR:-default}`. A default applies only when the variable is unset, not when
it is an empty string. Expansion is single-pass against Pi's environment; `env`
entries do not define variables for other entries. Missing variables and invalid
expanded values fail without echoing credentials. Stdio inherits the SDK's
minimal platform environment plus explicit `env`, not the entire Pi environment.
Credentials and fragments in HTTP URLs are rejected; use headers for credentials.
Unknown fields invalidate their server entry rather than being silently ignored.

### Configuration errors

An invalid server entry is skipped without hiding healthy servers. Discovery's
`servers` list includes a safe diagnostic for each skipped entry; a valid server
name can still be used with `mcp({ action: "list", server: "name" })` to inspect
its status. Invalid names are replaced with their one-based entry positions.
Diagnostics identify supported fields or migration steps without echoing URLs,
commands, headers, argument values, or environment-variable names.

Malformed JSON, invalid root structure, unknown root fields, and the file/server
count limits remain fatal for the whole file. An invalid-only configuration
reports that no valid servers remain. Disabled entries are omitted, not reported
as failed connections. Correct the file and reload Pi to retry.

Configuration trust still applies before any valid server is started or its
metadata exposed.

### Deadlines and migration

All three deadline fields accept integers from 1 through 2,147,483,647 milliseconds
(Node's timer-safe maximum). Each defaults independently to 30 seconds. Setting
`"timeout": 960000` permits a 16-minute tool call without lengthening startup or
discovery. The call clock starts after connection startup;
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

### Tool-call control

Like Pi's built-in tools, loaded MCP tools execute without adapter-specific
permission prompts in both interactive and headless sessions. Native calls pass
through Pi's normal `tool_call` and `tool_result` hooks. For approvals or access
policies, install a Pi extension that handles `tool_call` so it can manage MCP
and other tools together. Server annotations do not bypass those hooks.
Configuration trust above is separate: it authorizes startup, not individual calls.

**Migration from 0.0.2:** Remove the server-level `approve` field. Entries that
still contain it are rejected with migration guidance rather than silently
ignoring an existing policy. If you relied on `approve: true`, configure an
external permission extension before removing it.

Child stderr and raw SDK errors are not printed because they can contain
credentials; debug a failing server separately in a trusted environment.

## Discovery and execution

At session startup, the adapter connects to trusted servers and fetches their
paginated tool catalogs. A server's configuration, connection, or discovery
failure does not hide tools from other servers.
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
avoid normalization collisions. Independent native calls can run concurrently;
permission extensions must coordinate any shared approval UI. Discovered tools
stay active until session shutdown or a server catalog change.
Changed and removed definitions are withdrawn; changed tools require loading
again. Unsupported input schemas or metadata, name collisions, and task-only
tools are counted as `unsupportedTools` in discovery results. Each server with
rejections also includes up to five `rejections` and an `omittedRejections`
count. Each rejection has a one-based catalog `index`, an adapter-owned `code`
and `message`, and the original `tool` name only if it passes name validation.
For example, `draft07-reference` identifies unsupported draft-07 references;
`unsupported-dialect` identifies an unrecognized dialect. These diagnostics are
returned by list, search, and load, and replaced on each catalog refresh. Raw
exceptions, schema contents, invalid tool names, and dialect URLs are not exposed.

An unsupported output schema still fails that server's discovery rather than
producing a per-tool rejection. Losing an established HTTP notification stream
also withdraws tools rather than silently keeping a stale catalog; servers that
decline the optional stream with HTTP 405 remain usable. Reload Pi to reconnect
a failed server or reread configuration.

Pi handles provider compatibility. Some providers support transcript-anchored
schema additions; others rebuild the tool set and may invalidate prompt caches.
For very small catalogs, eager loading would avoid a discovery round trip, but
v1 intentionally offers only the deferred mode.

### Schema compatibility

Schemas without `$schema` use MCP's default JSON Schema 2020-12 dialect. Explicit
2020-12 schemas and a conservative draft-07 subset are supported. Draft-07
accepts `http://json-schema.org/draft-07/schema` and its HTTPS spelling, with or
without a trailing `#`.

Draft-07 schemas are syntax-checked against their own bundled meta-schema, then
checked against this keyword allowlist:

| Category | Supported draft-07 keywords |
| --- | --- |
| Types and values | `type` (including unions), `enum`, `const`, boolean subschemas |
| Objects | `properties`, `patternProperties`, `additionalProperties`, `required`, `propertyNames`, `minProperties`, `maxProperties` |
| Arrays | Schema-valued `items`, `contains`, `minItems`, `maxItems`, `uniqueItems: false` |
| Numbers | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` |
| Strings | `minLength`, `maxLength`, `pattern` |
| Composition | `allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`, `else` |
| Metadata and storage | `$comment`, `title`, `description`, `default`, `examples`, `readOnly`, `writeOnly`, `definitions` |

After these checks, the schema is normalized to equivalent 2020-12 constraints.
String length bounds must be safe integers and become Unicode patterns that
count code points rather than Pi's native grapheme-cluster lengths. Object
normalization also avoids an incorrect native property-count optimization.
The normalized schema is both exposed to Pi and used for adapter validation;
output schemas use the same compatibility policy. Literal data in annotations,
`const`, and `enum` is preserved without interpreting it as a schema. Pi's normal
argument coercion still applies before adapter execution.

`multipleOf`, `uniqueItems: true`, and `properties`/`required` names inherited from
`Object.prototype` (for example, `toString`, `constructor`, and `__proto__`) are
rejected with specific diagnostics. Pi's current validator uses inexact numeric
comparisons, lossy uniqueness hashes, and inherited-property checks for these
constructs; accepting them would not preserve JSON Schema semantics. These
compatibility restrictions and normalizations apply to draft-07 admission;
existing default/2020-12 validation behavior is unchanged.

`const` and `enum` literals cannot contain arrays, even nested inside objects:
native equality can conflate array literals with unequal objects. Arrays in
annotation data such as `default` and `examples` remain legal. Numeric
backreferences in `patternProperties` are also rejected, regardless of
`additionalProperties`, because native pattern combination changes their capture
indices. Escaped literal backslashes and named backreferences remain supported.

Draft-07 references (including local references), `$id`, nested `$schema`
declarations, tuple `items`, `additionalItems`, `dependencies`, `format`, content
keywords, and other unlisted keywords are rejected. In particular, newer keywords
such as `dependentRequired` cannot silently become constraints. This is not a
complete draft-07 converter. For unsupported dialect constructs, the server must
supply an equivalent supported schema—not merely remove or change `$schema`.
Embedded draft-07 declarations inside a 2020-12 document also remain unsupported.

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
Schemas are syntax-checked before compilation; see [schema compatibility](#schema-compatibility)
for supported dialects and the draft-07 subset. Schema nesting is limited to 64
levels, including literal data. External schema references are unsupported, but
literal `$ref` fields inside instance data are allowed. Meta-schema validation
never fetches a server-provided URL.

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

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.
