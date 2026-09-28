# Contributing

Read and follow the repository-wide
[contribution guide](https://github.com/46ki75/pix/blob/main/CONTRIBUTING.md) before changing this package.

Keep this package focused on GitHub Copilot prompt files and the MCP prompts
interface. Do not add client-specific model, agent, or tool control. Preserve
stdout exclusively for stdio JSON-RPC traffic, and treat discovered paths,
metadata, prompt bodies, arguments, and attachments as untrusted input.

Run focused validation from the repository root while developing:

```sh
mise run test --project mcp-copilot-prompts
pnpm --filter @ikuma.cloud/mcp-copilot-prompts exec tsc --project tsconfig.json
pnpm --filter @ikuma.cloud/mcp-copilot-prompts run build
```

Before submitting, run the repository's required `mise run check`. When changing
published files or the CLI, also inspect:

```sh
pnpm --filter @ikuma.cloud/mcp-copilot-prompts pack --dry-run
```

Verify the compiled binary through an MCP client.
