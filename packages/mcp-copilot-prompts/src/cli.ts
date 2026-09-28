#!/usr/bin/env node

import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseCliArguments, selectFallbackRootPath } from "./cli-options.js";
import { canonicalizeRoot, canonicalizeRoots } from "./roots.js";
import { CopilotPromptServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import type { Diagnostic } from "./types.js";
import { sanitizeInline } from "./util.js";

const HELP = `Usage: mcp-copilot-prompts [options]

Expose .github/prompts/*.prompt.md files through MCP over stdio.

Options:
  --root <path>             Prompt root; repeat for multiple roots
  --allow-home-references  Allow prompt files to attach ~/ paths
  -h, --help               Show this help
  -v, --version            Show the version

Without --root, the server uses client-provided MCP roots when available and
otherwise uses its working directory.
`;

function reportDiagnostic(diagnostic: Diagnostic): void {
  process.stderr.write(
    `[${SERVER_NAME}] ${sanitizeInline(diagnostic.path)}: ${sanitizeInline(diagnostic.message)}\n`,
  );
}

async function main(): Promise<void> {
  const options = parseCliArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const fallbackRootPath = selectFallbackRootPath(options.roots, () =>
    process.cwd(),
  );
  const [explicitRoots, fallbackRoot] = await Promise.all([
    canonicalizeRoots(options.roots.map((path) => ({ path }))),
    canonicalizeRoot({ path: fallbackRootPath }),
  ]);
  const service = await CopilotPromptServer.create({
    explicitRoots,
    fallbackRoot,
    allowHomeReferences: options.allowHomeReferences,
    reportDiagnostic,
  });
  const transport = new StdioServerTransport();
  let shuttingDown: Promise<void> | undefined;
  const shutdown = (exitCode: number): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    process.exitCode = exitCode;
    shuttingDown = service.close();
    return shuttingDown;
  };
  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));
  process.stdin.once("end", () => void shutdown(0));

  try {
    await service.server.connect(transport);
  } catch (error) {
    await shutdown(1);
    throw error;
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[${SERVER_NAME}] ${sanitizeInline(message)}\n`);
  process.exitCode = 1;
}
