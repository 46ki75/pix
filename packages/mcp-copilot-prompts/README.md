# @ikuma.cloud/mcp-copilot-prompts

A local stdio [Model Context Protocol](https://modelcontextprotocol.io/) server that
exposes GitHub Copilot `.prompt.md` files as user-selected MCP prompts. It does
not expose prompts as model-callable tools.

GitHub Copilot prompt files are deprecated for VS Code Agent Host sessions, but
this server provides a compatibility path for repositories that already use
them.

## Installation

Install the server so that your MCP client can launch its binary:

```sh
npm install --global @ikuma.cloud/mcp-copilot-prompts
mcp-copilot-prompts --help
```

Package-manager download commands can also launch it, but pin the package
version and review that behavior before placing such a command in an
automatically loaded MCP configuration.

## Configuration

The server communicates over stdio. A typical project-level MCP declaration is:

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

MCP configuration files and working-directory behavior are client-specific. With
[`@ikuma.cloud/pix-mcp`](https://github.com/46ki75/pix/tree/main/packages/pix-mcp), place this entry in the project's
`.mcp.json`; its default stdio working directory is the directory containing that
file. Then use:

```text
/mcp-prompt
/mcp-prompt run copilot-prompts <prompt> [name=value ...]
```

Review project MCP configuration before loading it. In particular, a bare
`.mcp.json` is not protected by Pi's project-trust mechanism and can declare any
local executable.

### Command-line options

```text
--root <path>             Prompt root; repeat for multiple roots
--allow-home-references  Allow prompt files to attach ~/ paths
-h, --help               Show help
-v, --version            Show the version
```

Root selection uses explicit `--root` values first. Without them, the server
uses roots supplied by an MCP client that supports `roots/list`, falling back to
its working directory when that capability is unavailable. Empty client roots
produce an empty prompt catalog; a failed `roots/list` request also fails closed
with no roots. `pix-mcp` does not currently supply MCP roots, so use `--root .`
there.

For each root, the server discovers direct `.prompt.md` children of
`.github/prompts`. Unique Copilot names remain unchanged. A name shared across
multiple roots is exposed as `<root>/<name>`; duplicate names within one root are
omitted. File changes update the catalog and emit
`notifications/prompts/list_changed`.

## Compatibility

| Copilot prompt-file feature | Behavior |
| --- | --- |
| `name` | MCP prompt name; filename without `.prompt.md` is the fallback |
| `description` | MCP prompt description |
| `${input:name}` | Required MCP string argument |
| `${input:name:placeholder}` | Required argument with the placeholder as its description |
| `${workspaceFolder}` | Configured root path |
| `${workspaceFolderBasename}` | Configured root basename |
| Relative Markdown file links | Attached as embedded MCP resources |
| `#file:path` | Attached as embedded MCP resources |
| `~/...` references | Disabled unless `--allow-home-references` is set |
| `argument-hint` | Preserved in namespaced MCP `_meta` |
| `agent`, `model`, `tools` | Preserved in `_meta`, but not applied to the client |
| `#tool:name` | Preserved as prompt text; no tool is activated |
| Editor variables such as `${selection}` and `${file}` | Rejected with an unsupported-variable error |
| Extra invocation text | No direct MCP equivalent; edit the rendered prompt or declare an input |

Inputs are expanded once. Values are never reinterpreted as variables or file
references. Ordinary HTTP links remain links and are never fetched.

Referenced UTF-8 text and validated PNG, JPEG, GIF, or WebP images are returned
as embedded resources. Normal references must remain within their configured
root after symlink resolution. Home references, when enabled, must remain within
the user's home directory. Missing, unreadable, oversized, binary, absolute, and
escaping references fail prompt retrieval rather than silently omitting context.

## Security and limits

Prompt metadata, bodies, and attachments are untrusted repository content. The
server reads prompt bodies for discovery, but returns a body and reads referenced
files only after a user requests that prompt. It does not execute commands,
invoke tools, or make network requests. Clients remain responsible for showing
or confirming returned content before sending it to a model.

The implementation bounds root count, prompt count and size, input and argument
sizes, rendered body size, reference count, per-reference size, and total
attachment size. Malformed files
are isolated from valid prompts and reported on stderr; stdout is reserved for
MCP traffic. Prompt catalogs are paginated, and cursors become invalid after a
catalog change.

## Development

**Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.**

From the repository root:

```sh
mise run test --project mcp-copilot-prompts
pnpm --filter @ikuma.cloud/mcp-copilot-prompts run build
mise run check
```

Format details are based on the
[VS Code prompt-file documentation](https://code.visualstudio.com/docs/agent-customization/prompt-files).
Protocol behavior follows the
[MCP prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)
and [MCP roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots)
specifications.
