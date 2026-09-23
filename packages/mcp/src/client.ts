import { AsyncLocalStorage } from "node:async_hooks";
import { fetch as undiciFetch, getGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { mediaTypeEssence } from "@modelcontextprotocol/sdk/shared/mediaType.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
  ToolListChangedNotificationSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config.ts";
import { compileSchema, schemaValidator } from "./schema.ts";

// SDK 1.30's property decoder incorrectly requires every property schema to be
// an object. JSON Schema 2020-12 also permits true/false. Preserve those values
// through the wire decoder; our meta-schema checks validate their actual syntax.
const catalogResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.extend({
    inputSchema: ToolSchema.shape.inputSchema.omit({ properties: true }),
    outputSchema: ToolSchema.shape.outputSchema
      .unwrap()
      .omit({ properties: true })
      .optional(),
  }).array(),
});

export class Connection {
  readonly client: Client;
  readonly config: ServerConfig;
  status = "Not connected";
  instructions = "";
  #transport: StdioClientTransport | StreamableHTTPClientTransport;
  #lifetime = new AbortController();
  #initializing: Promise<void> | undefined;
  #refreshing: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #dirty = false;
  #stopped = false;
  #changed: (tools: Tool[]) => void;
  #outputValidators = new Map<string, ReturnType<typeof compileSchema>>();
  #operation = new AsyncLocalStorage<AbortSignal>();

  constructor(config: ServerConfig, changed: (tools: Tool[]) => void) {
    this.config = config;
    this.#changed = changed;
    this.client = new Client(
      { name: "pix-mcp", version: "0.0.0" },
      { capabilities: {}, jsonSchemaValidator: schemaValidator },
    );
    this.#transport =
      config.type === "stdio"
        ? new StdioClientTransport({
            command: config.command,
            args: config.args,
            cwd: config.cwd,
            env: config.env,
            stderr: "ignore",
            maxBufferSize: 16 * 1024 * 1024,
          })
        : new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: { headers: config.headers, redirect: "error" },
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
            fetch: (url, init) => this.#fetch(url, init),
          });
    this.client.onerror = () => {
      /* Request failures are reported without leaking SDK error payloads. */
    };
    this.client.onclose = () => this.#disconnect();
    this.client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      async () => {
        if (this.#stopped) return;
        try {
          await this.refresh();
        } catch {
          /* refresh already clears the stale catalog */
        }
      },
    );
  }

  #disconnect() {
    if (this.#stopped || this.#lifetime.signal.aborted) return;
    this.status = "Disconnected; reload Pi to reconnect";
    this.#lifetime.abort(
      new Error("MCP connection is unavailable; reload Pi to reconnect."),
    );
    this.#outputValidators.clear();
    this.#changed([]);
    void this.client.close().catch(() => {});
  }

  async #deadline<T>(
    timeout: number,
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const outer = signal
      ? AbortSignal.any([signal, this.#lifetime.signal])
      : this.#lifetime.signal;
    outer.throwIfAborted();
    const deadline = new AbortController();
    const transport = new AbortController();
    const abort = () => deadline.abort(outer.reason);
    outer.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => deadline.abort(new Error("MCP operation timed out.")),
      timeout,
    );
    try {
      // SDK 1.30 does not forward request signals to HTTP fetch. Async context
      // keeps concurrent requests isolated without relying on private SDK IDs.
      return await this.#operation.run(
        AbortSignal.any([deadline.signal, transport.signal]),
        () => action(deadline.signal),
      );
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", abort);
      // Use a separate signal: aborting the SDK signal after success would send
      // a spurious cancellation for an already-completed request in SDK 1.30.
      transport.abort();
    }
  }

  async #fetch(
    url: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ) {
    // Borrow the host's routing/proxy dispatcher, but override idle limits only
    // for this request. Our AbortSignals bound headers AND bodies. Use the same
    // Undici implementation as the dispatcher to preserve decompression behavior.
    const dispatcher = getGlobalDispatcher().compose(
      (dispatch) => (options, handler) =>
        dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler),
    );
    const fetch = (signal: AbortSignal) => {
      const request = {
        ...init,
        redirect: "error" as const,
        signal,
        dispatcher,
      };
      // SDK/global fetch and npm Undici expose different DOM type declarations;
      // the SDK sends a URL and a serialized JSON body, compatible with both.
      return undiciFetch(
        url as Parameters<typeof undiciFetch>[0],
        request as Parameters<typeof undiciFetch>[1],
      ) as unknown as Promise<Response>;
    };
    // Teardown must still send DELETE after the connection lifetime is aborted.
    if (init?.method === "DELETE") return fetch(AbortSignal.timeout(2000));
    const signals = [
      this.#lifetime.signal,
      ...(init?.signal ? [init.signal] : []),
    ];
    if (init?.method !== "GET") {
      // This body is generated by the SDK, not server input. Cancellation must
      // outlive the canceled operation so its best-effort notification can send.
      const cancelled =
        typeof init?.body === "string" &&
        JSON.parse(init.body).method === "notifications/cancelled";
      const operation = cancelled ? undefined : this.#operation.getStore();
      return fetch(
        AbortSignal.any([...signals, operation ?? AbortSignal.timeout(2000)]),
      );
    }
    // GET is optional (405 is valid), but an established notification stream
    // cannot disappear silently: with retries disabled its catalog is stale.
    const headersDeadline = new AbortController();
    const timer = setTimeout(
      () => headersDeadline.abort(),
      this.config.startupTimeoutMs,
    );
    try {
      const response = await fetch(
        AbortSignal.any([...signals, headersDeadline.signal]),
      );
      if (response.status === 405) return response;
      if (
        !response.ok ||
        !response.body ||
        mediaTypeEssence(response.headers.get("content-type")) !==
          "text/event-stream"
      ) {
        await response.body?.cancel();
        throw new Error("MCP notification stream unavailable.");
      }
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      void response.body.pipeTo(stream.writable).then(
        () => this.#disconnect(),
        () => this.#disconnect(),
      );
      return new Response(stream.readable, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      this.#disconnect();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  start(): Promise<void> {
    this.#initializing ??= this.#start();
    return this.#initializing;
  }

  async #start(): Promise<void> {
    try {
      this.#lifetime.signal.throwIfAborted();
      this.status = "Connecting";
      // SDK transport getters include undefined while its optional Transport field
      // does not under exactOptionalPropertyTypes; the runtime contract is identical.
      // SDK request timeouts do not cover the awaited notifications/initialized
      // send. Bound the whole handshake and close the transport to release it.
      const handshakeTimer = setTimeout(
        () => this.#disconnect(),
        this.config.startupTimeoutMs,
      );
      try {
        await this.#deadline(
          this.config.startupTimeoutMs,
          undefined,
          (signal) =>
            this.client.connect(this.#transport as Transport, {
              signal,
              timeout: this.config.startupTimeoutMs,
            }),
        );
      } finally {
        clearTimeout(handshakeTimer);
      }
      this.#lifetime.signal.throwIfAborted();
      this.instructions = this.client.getInstructions() ?? "";
      await this.refresh();
    } catch {
      if (!this.#stopped) {
        this.status =
          "Connection or discovery failed; check configuration/authentication and reload Pi";
        this.#changed([]);
      }
      await this.client.close().catch(() => {});
      throw new Error(
        `MCP server ${this.config.name}: connection or discovery failed.`,
      );
    }
  }

  refresh(): Promise<void> {
    this.#dirty = true;
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<void> {
    try {
      while (this.#dirty && !this.#stopped) {
        this.#dirty = false;
        const tools: Tool[] = [];
        const cursors = new Set<string>();
        const names = new Set<string>();
        let cursor: string | undefined;
        let bytes = 0;
        await this.#deadline(
          this.config.catalogTimeoutMs,
          undefined,
          async (signal) => {
            if (this.client.getServerCapabilities()?.tools) {
              do {
                const page = await this.#deadline(
                  this.config.catalogTimeoutMs,
                  signal,
                  (requestSignal) =>
                    this.client.request(
                      {
                        method: "tools/list",
                        params: cursor === undefined ? {} : { cursor },
                      },
                      catalogResultSchema,
                      {
                        signal: requestSignal,
                        timeout: this.config.catalogTimeoutMs,
                      },
                    ),
                );
                bytes += Buffer.byteLength(JSON.stringify(page));
                if (
                  bytes > 2 * 1024 * 1024 ||
                  tools.length + page.tools.length > 1000
                )
                  throw new Error("Catalog limit");
                for (const tool of page.tools) {
                  if (names.has(tool.name))
                    throw new Error("Duplicate tool name");
                  names.add(tool.name);
                  tools.push(tool);
                }
                cursor = page.nextCursor;
                if (cursor !== undefined) {
                  if (cursors.has(cursor) || cursors.size >= 100)
                    throw new Error("Invalid pagination");
                  cursors.add(cursor);
                }
              } while (cursor !== undefined);
            }
            // Keep a complete, atomic validator snapshot rather than the SDK's
            // per-page mutable cache, including when a catalog changes during a call.
            const validators = new Map<
              string,
              ReturnType<typeof compileSchema>
            >();
            for (const tool of tools) {
              if (tool.outputSchema)
                validators.set(tool.name, compileSchema(tool.outputSchema));
            }
            signal.throwIfAborted();
            if (!this.#stopped) {
              this.#outputValidators = validators;
              this.status = "Connected";
              this.#changed(tools);
            }
          },
        );
      }
    } catch {
      if (!this.#stopped) {
        this.status = "Discovery failed; reload Pi to retry";
        this.#changed([]);
      }
      throw new Error(`MCP server ${this.config.name}: discovery failed.`);
    }
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    await this.start();
    const combined = signal
      ? AbortSignal.any([signal, this.#lifetime.signal])
      : this.#lifetime.signal;
    combined.throwIfAborted();
    const outputValidator = this.#outputValidators.get(name);
    try {
      // SDK callTool consults a mutable per-page validator after the response and
      // validates error payloads against success schemas. Use one typed request,
      // then our captured validator; task-only tools are excluded during discovery.
      // Never retry: a lost response does not prove the operation did not run.
      const result = await this.#deadline(
        this.config.timeout,
        combined,
        (requestSignal) =>
          this.client.request(
            { method: "tools/call", params: { name, arguments: args } },
            CallToolResultSchema,
            {
              signal: requestSignal,
              timeout: this.config.timeout,
              resetTimeoutOnProgress: false,
            },
          ),
      );
      const parsed = CallToolResultSchema.parse(result);
      if (
        !parsed.isError &&
        outputValidator &&
        !outputValidator.Check(parsed.structuredContent)
      ) {
        throw new Error("MCP output does not match the advertised schema.");
      }
      return parsed;
    } catch {
      combined.throwIfAborted();
      throw new Error(
        `MCP server ${this.config.name}: call failed or timed out. It may already have taken effect; do not retry blindly.`,
      );
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#stopped = true;
    this.#lifetime.abort();
    this.status = "Closed";
    if (
      this.#transport instanceof StreamableHTTPClientTransport &&
      this.#transport.sessionId
    ) {
      await this.#transport.terminateSession().catch(() => {});
    }
    await this.client.close().catch(() => {});
    await this.#initializing?.catch(() => {});
    await this.#refreshing?.catch(() => {});
  }
}
