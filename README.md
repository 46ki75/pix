# pix

A TypeScript monorepo for small [Pi Coding Agent](https://pi.dev/) extensions,
themes, and related MCP servers.

**Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.**

## Setup

Install [mise](https://mise.jdx.dev/getting-started.html), then run:

```sh
mise trust
mise install node pnpm
mise run setup
mise run check
```

Tool versions come from `mise.toml` and the root `package.json`. Tool downloads
are locked for macOS ARM64, Linux x64, and Linux ARM64. `pnpm-lock.yaml` locks
workspace dependencies.

## Continuous integration

[GitHub Actions](.github/workflows/check.yml) runs on pull requests and pushes to
`main`, with a manual **Run workflow** trigger in GitHub's Actions tab. The
`Check` job uses Ubuntu 24.04, installs the pinned tools through mise, and runs
`mise run setup` followed by `mise run check` for formatting, lint, type checking,
and all workspace tests.

Tool downloads and pnpm dependencies are cached. Dependency cache keys include
the manifests, lockfiles, workspace configuration, and dependency patches.
New runs cancel superseded runs for the same event and branch or pull request.

## Development

| Command | Purpose |
| --- | --- |
| `mise run setup` | Install locked dependencies and Git hooks |
| `mise run test` | Run all Vitest projects once |
| `mise run test --project pix-websearch` | Run one test project |
| `mise run test:watch` | Watch tests |
| `mise run typecheck` | Check root configuration and all packages |
| `mise run lint` | Lint tracked TypeScript and JavaScript files |
| `mise run fmt` | Format tracked TypeScript, JavaScript, and JSON files |
| `mise run fmt-check` | Check the same formatting scope |
| `mise run check` | Run formatting, lint, type checking, and tests |
| `mise run dev` | Launch Pi with all local extensions and Elmethis themes |
| `mise run websearch:dev` | Launch Pi with @ikuma.cloud/pix-websearch |
| `mise run webfetch:dev` | Launch Pi with @ikuma.cloud/pix-webfetch |
| `mise run web:dev` | Launch Pi with both web tools |
| `mise run mcp-prompt:dev` | Launch native MCP with @ikuma.cloud/pix-mcp-prompt |
| `mise run mcp:dev` | Launch the legacy @ikuma.cloud/pix-mcp adapter |
| `mise run bg:dev` | Launch Pi with only @ikuma.cloud/pix-bg |
| `mise run statusline:dev` | Launch Pi with only @ikuma.cloud/pix-statusline |
| `mise run usage:dev` | Launch Pi with only @ikuma.cloud/pix-usage |
| `mise run theme-inspector:dev` | Launch Pi with only @ikuma.cloud/pix-theme-inspector |
| `mise run theme-elmethis:dev` | Launch Pi with Elmethis themes in automatic light/dark mode |

The `dev` task runs from the repository root and disables automatically loaded
extensions. It accepts Pi arguments, for example `mise run dev --help`.

[`@ikuma.cloud/pix-websearch`](packages/pix-websearch/README.md) adds a `websearch` tool with
keyless Exa, Parallel, Firecrawl, Tavily, and TinyFish access. Run
`mise run websearch:dev` to try it, or
`mise run test --project pix-websearch` for its tests.

[`@ikuma.cloud/pix-webfetch`](packages/pix-webfetch/README.md) adds an independent
`webfetch` tool for reading URLs as Markdown or text, with full-output files for
truncated previews. Run
`mise run webfetch:dev` to try it or `mise run web:dev` to use both web tools.
Its tests run with `mise run test --project pix-webfetch`.

Web search and web fetch have separate package versions and runtime dependencies,
so provider updates and content-extraction updates can be released independently.

[`@ikuma.cloud/pix-mcp-prompt`](packages/pix-mcp-prompt/README.md) is a private
migration preview for Pi **0.99.2**. It preserves `/mcp-prompt` while native Pi
handles tools and resources, using the same `mcp.json` configuration and project
trust. Prompt connections are separate and opened on first use. Run
`mise run mcp-prompt:dev` or `mise run test --project pix-mcp-prompt`.
The root development CLI is pinned to 0.99.2; existing packages retain their
independently tested development versions.

[`@ikuma.cloud/pix-mcp`](packages/pix-mcp/README.md) remains available as the legacy
adapter until its replacement is published and verified. Run `mise run mcp:dev`
or `mise run test --project pix-mcp` for its isolated development/tests. Do not
load both packages in one session. See the new package's migration guide before
changing configuration or removing the old adapter.

[`@ikuma.cloud/mcp-copilot-prompts`](packages/mcp-copilot-prompts/README.md) is a
local stdio MCP server that exposes repository `.github/prompts/*.prompt.md`
files as user-selected MCP prompts. It works with `pix-mcp-prompt` and other clients
that implement MCP prompts. Run `mise run test --project mcp-copilot-prompts`
for its tests.

[`@ikuma.cloud/pix-bg`](packages/pix-bg/README.md) runs background shell tasks with
completion wake-ups, capped log files, and a `/bg` task viewer. Run
`mise run bg:dev` for an isolated launch or `mise run test --project pix-bg`
for its tests. Tasks stop on reload, session replacement, and quit.

[`@ikuma.cloud/pix-statusline`](packages/pix-statusline/README.md) adds a customizable
footer with model details, cache-hit rate, context utilization, and
Git-aware directory segments. Run `mise run statusline:dev` to try it or
`mise run test --project pix-statusline` for its tests.

[`@ikuma.cloud/pix-usage`](packages/pix-usage/README.md) adds on-demand `/usage`
reports for Claude, Codex, Meta Muse, and OpenCode Go subscription quotas using
Pi-managed credentials.
A current-provider widget appears by default in terminal sessions and refreshes
while visible, without replacing the footer. `/usage toggle` hides or shows it.
Run `mise run usage:dev` to try it or `mise run test --project pix-usage` for its
isolated tests.

[`@ikuma.cloud/pix-theme-inspector`](packages/pix-theme-inspector/README.md) adds
`/theme-colors` to inspect the active theme's semantic foreground and background
colors, with colored token names, background swatches, and effective RGB,
indexed, or terminal-default values.
Run `mise run theme-inspector:dev` to try it or
`mise run test --project pix-theme-inspector` for its isolated tests.

[`@ikuma.cloud/pix-theme-elmethis`](packages/pix-theme-elmethis/README.md) provides
`elmethis-dark` and `elmethis-light`, preserving the personal Ikuma Pi palettes
under new names. It is a theme-only package with no runtime dependencies.
Run `mise run theme-elmethis:dev` to try automatic light/dark switching or
`mise run test --project pix-theme-elmethis` for its validation tests.

## Layout

Each package lives in `packages/<unscoped-package-name>/`. Extensions, such as
`packages/pix-websearch/`, have their own Pi manifest, source, tests, and TypeScript
configuration. Shared tooling lives at the repository root. Pi loads the
TypeScript entry point declared by `package.json` directly. Theme-only packages
instead declare JSON resources through `pi.themes` and need no runtime code.
Standalone servers such as `packages/mcp-copilot-prompts/` compile a standard
Node.js CLI for use by Pi or other MCP clients.

Update local path-based installations if your checkout previously used shorter
directory names. Published npm package names and mise task names are unchanged.

See [the contribution guide](CONTRIBUTING.md#adding-an-extension) for the package
conventions and [Pi's extension documentation](https://pi.dev/docs/latest/extensions)
for the API.
