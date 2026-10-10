#!/usr/bin/env node

import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWebServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

const HELP = `Usage: mcp-web [options]

Expose websearch and webfetch through one MCP server over stdio.

Options:
  -h, --help     Show this help
  -v, --version  Show the version

PIX_WEBSEARCH_PROVIDER: auto (default), none, a provider, or a comma-separated list
Providers: exa, parallel, firecrawl, tavily, tinyfish
Optional API keys: EXA_API_KEY, PARALLEL_API_KEY, FIRECRAWL_API_KEY,
                  TAVILY_API_KEY, TINYFISH_API_KEY
`;

function report(error: unknown): void {
  const message = error instanceof Error ? error.message : "Server failed.";
  process.stderr.write(
    `[${SERVER_NAME}] ${message.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")}\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (args.length !== 0) {
    throw new Error("Unsupported arguments. Use --help for usage.");
  }

  const server = createWebServer();
  let closing: Promise<void> | undefined;
  const shutdown = (exitCode: number): Promise<void> => {
    if (closing) return closing;
    process.exitCode = exitCode;
    closing = server.close().catch((error: unknown) => {
      report(error);
      process.exitCode = 1;
    });
    return closing;
  };
  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));
  process.stdin.once("end", () => void shutdown(0));
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await shutdown(1);
    throw error;
  }
}

try {
  await main();
} catch (error) {
  report(error);
  process.exitCode = 1;
}
