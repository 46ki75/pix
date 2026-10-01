import type {
  JsonRpcId,
  JsonRpcMessage,
  McpTransport,
  ServerCapabilities,
} from "@earendil-works/pi-mcp";

export class FixtureRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FixtureRequestContext {
  id: JsonRpcId;
  progressToken: JsonRpcId | undefined;
  progress(value: number): Promise<void>;
}

export interface PromptFixtureOptions {
  capabilities?: ServerCapabilities;
  initialize?: (
    params: Record<string, unknown> | undefined,
  ) => unknown | Promise<unknown>;
  request?: (
    method: string,
    params: Record<string, unknown> | undefined,
    context: FixtureRequestContext,
  ) => unknown | Promise<unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class PromptFixtureServer {
  readonly methods: string[] = [];
  readonly cancellations: unknown[] = [];
  readonly rootResponses: unknown[] = [];
  readonly transport: McpTransport;
  #options: PromptFixtureOptions;
  #nextRequestId = 10_000;
  #pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();

  constructor(transport: McpTransport, options: PromptFixtureOptions = {}) {
    this.transport = transport;
    this.#options = options;
    transport.onMessage((message) => {
      void this.#handle(message);
    });
  }

  setRequestHandler(handler: PromptFixtureOptions["request"]): void {
    if (handler) this.#options.request = handler;
    else delete this.#options.request;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async notifyPromptsChanged(): Promise<void> {
    await this.transport.send({
      jsonrpc: "2.0",
      method: "notifications/prompts/list_changed",
    });
  }

  async requestRoots(): Promise<unknown> {
    const id = this.#nextRequestId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    await this.transport.send({
      jsonrpc: "2.0",
      id,
      method: "roots/list",
    });
    const result = await response;
    this.rootResponses.push(result);
    return result;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  async #handle(message: JsonRpcMessage): Promise<void> {
    if (!("method" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if ("error" in message) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (!("id" in message)) {
      this.methods.push(message.method);
      if (
        message.method === "notifications/cancelled" &&
        isObject(message.params)
      )
        this.cancellations.push(message.params.requestId);
      return;
    }

    this.methods.push(message.method);
    const params = isObject(message.params) ? message.params : undefined;
    try {
      let result: unknown;
      if (message.method === "initialize") {
        result = this.#options.initialize
          ? await this.#options.initialize(params)
          : {
              protocolVersion: "2025-11-25",
              capabilities: this.#options.capabilities ?? {
                prompts: { listChanged: true },
              },
              serverInfo: { name: "prompt-fixture", version: "1.0.0" },
            };
      } else if (this.#options.request) {
        const meta = isObject(params?._meta) ? params._meta : undefined;
        const progressToken =
          typeof meta?.progressToken === "string" ||
          typeof meta?.progressToken === "number"
            ? meta.progressToken
            : undefined;
        result = await this.#options.request(message.method, params, {
          id: message.id,
          progressToken,
          progress: async (progress) => {
            if (progressToken === undefined) return;
            await this.transport.send({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { progressToken, progress },
            });
          },
        });
      } else if (message.method === "prompts/list") {
        result = { prompts: [{ name: "review" }] };
      } else if (message.method === "prompts/get") {
        result = {
          messages: [
            { role: "user", content: { type: "text", text: "Review this." } },
          ],
        };
      } else {
        throw new FixtureRpcError(
          -32601,
          `Method not found: ${message.method}`,
        );
      }
      await this.transport.send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      const rpcError =
        error instanceof FixtureRpcError
          ? error
          : new FixtureRpcError(-32603, "Fixture request failed");
      await this.transport.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: rpcError.code, message: rpcError.message },
      });
    }
  }
}
