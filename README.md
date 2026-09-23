# pix

A TypeScript monorepo for small [Pi Coding Agent](https://pi.dev/) extensions.

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
| `mise run lint` | Lint tracked TypeScript, JavaScript, and JSON files |
| `mise run fmt` | Format those files |
| `mise run fmt-check` | Check the same formatting scope |
| `mise run check` | Run formatting, lint, type checking, and tests |
| `mise run websearch:dev` | Launch Pi with @ikuma.cloud/pix-websearch |
| `mise run webfetch:dev` | Launch Pi with @ikuma.cloud/pix-webfetch |
| `mise run web:dev` | Launch Pi with both web tools |
| `mise run mcp:dev` | Launch Pi with only @ikuma.cloud/pix-mcp |

[`@ikuma.cloud/pix-websearch`](packages/websearch/README.md) adds a `websearch` tool with
keyless Exa, Parallel, Firecrawl, Tavily, and TinyFish access. Run
`mise run websearch:dev` to try it, or
`mise run test --project pix-websearch` for its tests.

[`@ikuma.cloud/pix-webfetch`](packages/webfetch/README.md) adds an independent
`webfetch` tool for reading URLs as Markdown or text, with full-output files for
truncated previews. Run
`mise run webfetch:dev` to try it or `mise run web:dev` to use both web tools.
Its tests run with `mise run test --project pix-webfetch`.

Web search and web fetch have separate package versions and runtime dependencies,
so provider updates and content-extraction updates can be released independently.

[`@ikuma.cloud/pix-mcp`](packages/mcp/README.md) connects to configured stdio and
Streamable HTTP MCP servers, exposes compact discovery, and activates native tool
schemas on demand. Run `mise run mcp:dev` for an isolated development launch or
`mise run test --project pix-mcp` for its tests. Review its configuration trust and
invocation approval requirements before connecting servers.

## Layout

Each extension lives in `packages/<name>/`, with its own Pi manifest, source,
tests, and TypeScript configuration. Shared tooling lives at the repository root.
Pi loads the TypeScript entry point declared by `package.json` directly.

See [the contribution guide](CONTRIBUTING.md#adding-an-extension) for the package
conventions and [Pi's extension documentation](https://pi.dev/docs/latest/extensions)
for the API.
