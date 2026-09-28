import { relative } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
  RootsListChangedNotificationSchema,
  type ListPromptsResult,
  type Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import { PromptCatalog } from "./catalog.js";
import { PROMPT_PAGE_SIZE } from "./limits.js";
import { PromptReferenceError } from "./references.js";
import { PromptRenderError, renderPrompt } from "./renderer.js";
import { rootsFromMcp } from "./roots.js";
import type { CatalogPrompt, Diagnostic, PromptRoot } from "./types.js";
import { sanitizeInline } from "./util.js";

export const SERVER_NAME = "mcp-copilot-prompts";
export const SERVER_VERSION = "0.0.1";
const META_KEY = "cloud.ikuma/mcp-copilot-prompts";
const ROOTS_TIMEOUT_MS = 5_000;

export interface CopilotPromptServerOptions {
  explicitRoots: PromptRoot[];
  fallbackRoot: PromptRoot;
  allowHomeReferences: boolean;
  reportDiagnostic?: (diagnostic: Diagnostic) => void;
  watch?: boolean;
}

function promptMetadata(entry: CatalogPrompt): Prompt {
  const { prompt } = entry;
  const compatibility = {
    source: relative(prompt.rootPath, prompt.sourcePath),
    ...(prompt.metadata.argumentHint === undefined
      ? {}
      : { argumentHint: prompt.metadata.argumentHint }),
    ...(prompt.metadata.agent === undefined
      ? {}
      : { agent: prompt.metadata.agent }),
    ...(prompt.metadata.model === undefined
      ? {}
      : { model: prompt.metadata.model }),
    ...(prompt.metadata.tools === undefined
      ? {}
      : { tools: prompt.metadata.tools }),
  };
  return {
    name: entry.exposedName,
    ...(entry.exposedName === prompt.name ? {} : { title: prompt.name }),
    ...(prompt.description === undefined
      ? {}
      : { description: prompt.description }),
    ...(prompt.inputs.length === 0
      ? {}
      : {
          arguments: prompt.inputs.map((input) => ({
            name: input.name,
            required: true,
            ...(input.placeholder === undefined
              ? {}
              : { description: input.placeholder }),
          })),
        }),
    _meta: { [META_KEY]: compatibility },
  };
}

function encodeCursor(generation: number, offset: number): string {
  return `${generation}.${offset}`;
}

function decodeCursor(
  cursor: string | undefined,
  generation: number,
  length: number,
): number {
  if (cursor === undefined) return 0;
  const match = /^(\d+)\.(\d+)$/u.exec(cursor);
  if (!match)
    throw new McpError(ErrorCode.InvalidParams, "Invalid prompt cursor");
  const cursorGeneration = Number(match[1]);
  const offset = Number(match[2]);
  if (
    !Number.isSafeInteger(cursorGeneration) ||
    cursorGeneration !== generation
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Prompt catalog changed; restart pagination",
    );
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= length) {
    throw new McpError(ErrorCode.InvalidParams, "Invalid prompt cursor");
  }
  return offset;
}

export class CopilotPromptServer {
  readonly server: Server;
  private readonly catalog: PromptCatalog;
  private readonly explicitRoots: PromptRoot[];
  private readonly fallbackRoot: PromptRoot;
  private readonly allowHomeReferences: boolean;
  private readonly reportDiagnostic:
    | ((diagnostic: Diagnostic) => void)
    | undefined;
  private rootsReady: Promise<void> = Promise.resolve();
  private rootsReloadPending = false;
  private rootsReloadRunning = false;
  private initialized = false;
  private closed = false;
  private closing: Promise<void> | undefined;

  private constructor(options: CopilotPromptServerOptions) {
    this.explicitRoots = options.explicitRoots;
    this.fallbackRoot = options.fallbackRoot;
    this.allowHomeReferences = options.allowHomeReferences;
    this.reportDiagnostic = options.reportDiagnostic;
    this.server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        capabilities: { prompts: { listChanged: true } },
        enforceStrictCapabilities: true,
        instructions:
          "Select Copilot prompt files explicitly. Prompt metadata cannot change the client's model, agent, or tools.",
      },
    );
    this.catalog = new PromptCatalog({
      ...(options.reportDiagnostic === undefined
        ? {}
        : { reportDiagnostic: options.reportDiagnostic }),
      ...(options.watch === undefined ? {} : { watch: options.watch }),
      onChanged: async () => {
        if (!this.initialized || this.closed) return;
        try {
          await this.server.sendPromptListChanged();
        } catch (error) {
          this.report("failed to send prompt catalog notification", error);
        }
      },
    });
    this.registerHandlers();
  }

  static async create(
    options: CopilotPromptServerOptions,
  ): Promise<CopilotPromptServer> {
    const service = new CopilotPromptServer(options);
    // Delay fallback discovery until initialization reveals whether the client
    // supplies narrower MCP roots.
    const initialRoots =
      options.explicitRoots.length > 0 ? options.explicitRoots : [];
    await service.catalog.setRoots(initialRoots);
    return service;
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      await this.rootsReady;
      await this.refreshOrThrow();
      const snapshot = this.catalog.snapshot();
      const offset = decodeCursor(
        request.params?.cursor,
        snapshot.generation,
        snapshot.prompts.length,
      );
      const page = snapshot.prompts.slice(offset, offset + PROMPT_PAGE_SIZE);
      const nextOffset = offset + page.length;
      const result: ListPromptsResult = {
        prompts: page.map(promptMetadata),
        ...(nextOffset < snapshot.prompts.length
          ? { nextCursor: encodeCursor(snapshot.generation, nextOffset) }
          : {}),
      };
      return result;
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      await this.rootsReady;
      await this.refreshOrThrow();
      const entry = this.catalog.find(request.params.name);
      if (!entry) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown prompt ${JSON.stringify(sanitizeInline(request.params.name))}`,
        );
      }
      try {
        return await renderPrompt(entry.prompt, request.params.arguments, {
          allowHomeReferences: this.allowHomeReferences,
        });
      } catch (error) {
        if (
          error instanceof PromptRenderError ||
          error instanceof PromptReferenceError
        ) {
          throw new McpError(ErrorCode.InvalidParams, error.message);
        }
        this.report("failed to render a prompt", error);
        throw new McpError(ErrorCode.InternalError, "Failed to render prompt");
      }
    });

    this.server.setNotificationHandler(
      RootsListChangedNotificationSchema,
      async () => {
        if (this.explicitRoots.length > 0) return;
        this.queueClientRoots();
        await this.rootsReady;
      },
    );

    this.server.oninitialized = () => {
      this.initialized = true;
      if (this.explicitRoots.length === 0) this.queueClientRoots();
    };
  }

  private queueClientRoots(): void {
    if (this.closed) return;
    this.rootsReloadPending = true;
    if (this.rootsReloadRunning) return;
    this.rootsReloadRunning = true;
    this.rootsReady = this.drainClientRoots();
  }

  private async drainClientRoots(): Promise<void> {
    try {
      while (this.rootsReloadPending && !this.closed) {
        this.rootsReloadPending = false;
        await this.loadClientRoots();
      }
    } finally {
      this.rootsReloadRunning = false;
    }
  }

  private async loadClientRoots(): Promise<void> {
    let roots: PromptRoot[];
    if (!this.server.getClientCapabilities()?.roots) {
      roots = [this.fallbackRoot];
    } else {
      try {
        const result = await this.server.listRoots(undefined, {
          timeout: ROOTS_TIMEOUT_MS,
        });
        roots = await rootsFromMcp(result.roots);
      } catch (error) {
        this.report("failed to load client roots; using no roots", error);
        roots = [];
      }
    }
    if (!this.closed) await this.catalog.setRoots(roots);
  }

  private async refreshOrThrow(): Promise<void> {
    try {
      await this.catalog.refresh();
    } catch (error) {
      this.report("failed to refresh the prompt catalog", error);
      throw new McpError(
        ErrorCode.InternalError,
        "Failed to refresh prompt catalog",
      );
    }
  }

  private report(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.reportDiagnostic?.({
      path: ".github/prompts",
      message: `${message}: ${sanitizeInline(detail)}`,
    });
  }

  close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    this.rootsReloadPending = false;
    const results = await Promise.allSettled([
      this.server.close(),
      this.rootsReady,
    ]);
    try {
      await this.catalog.close();
    } catch (error) {
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      throw error;
    }
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
