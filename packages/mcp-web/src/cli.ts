#!/usr/bin/env node

import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command, CommanderError, Option } from "commander";
import { createWebServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { PROVIDER_IDS } from "./websearch/types.js";

function report(error: unknown): void {
  const message = error instanceof Error ? error.message : "Server failed.";
  process.stderr.write(
    `[${SERVER_NAME}] ${message.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")}\n`,
  );
}

async function main(): Promise<void> {
  const program = new Command()
    .name(SERVER_NAME)
    .description(
      "Expose websearch and webfetch through one MCP server over stdio.",
    )
    .helpOption("-h, --help", "Show this help")
    .version(SERVER_VERSION, "-v, --version", "Show the version")
    .addOption(
      new Option(
        "--provider <selection>",
        "search provider: auto, none, a name, or a comma-separated list",
      )
        .env("PIX_WEBSEARCH_PROVIDER")
        .default("auto"),
    )
    .addHelpText(
      "after",
      `
Providers: ${PROVIDER_IDS.join(", ")}
Blank values select auto. Lists form a pool, not a priority order.
Precedence: --provider > PIX_WEBSEARCH_PROVIDER > auto.
Optional API keys (environment only):
  EXA_API_KEY, PARALLEL_API_KEY, FIRECRAWL_API_KEY,
  TAVILY_API_KEY, TINYFISH_API_KEY
`,
    )
    .allowExcessArguments(false)
    .configureOutput({
      // Commander may echo credentials embedded in rejected arguments.
      outputError: () =>
        report(new Error("Unsupported arguments. Use --help for usage.")),
    })
    .exitOverride();
  program.parse();
  const { provider } = program.opts<{ provider: string }>();

  const server = createWebServer({
    env: { ...process.env, PIX_WEBSEARCH_PROVIDER: provider },
  });
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
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    report(error);
    process.exitCode = 1;
  }
}
