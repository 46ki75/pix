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

## Development

| Command | Purpose |
| --- | --- |
| `mise run setup` | Install locked dependencies and Git hooks |
| `mise run test` | Run all Vitest projects once |
| `mise run test --project hello` | Run one test project |
| `mise run test:watch` | Watch tests |
| `mise run typecheck` | Check root configuration and all packages |
| `mise run lint` | Lint tracked TypeScript, JavaScript, and JSON files |
| `mise run fmt` | Format those files |
| `mise run fmt-check` | Check the same formatting scope |
| `mise run check` | Run formatting, lint, type checking, and tests |
| `mise run hello:dev` | Launch Pi with the starter extension |
| `mise run websearch:dev` | Launch Pi with @ikuma.cloud/pix-websearch |
| `mise run webfetch:dev` | Launch Pi with @ikuma.cloud/pix-webfetch |
| `mise run web:dev` | Launch Pi with both web tools |

`packages/hello` contains a minimal `/hello [name]` command. Run
`mise run hello:dev`, then enter `/hello Pi`. Restart that command after editing
the extension. Its integration test loads the actual Pi package manifest and
invokes the command without making model requests.

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

## Layout

Each extension lives in `packages/<name>/`, with its own Pi manifest, source,
tests, and TypeScript configuration. Shared tooling lives at the repository root.
Pi loads the TypeScript entry point declared by `package.json` directly.

See [the contribution guide](CONTRIBUTING.md#adding-an-extension) for the package
conventions and [Pi's extension documentation](https://pi.dev/docs/latest/extensions)
for the API.
