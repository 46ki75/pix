import { AsyncLocalStorage } from "node:async_hooks";
import { fetch as undiciFetch, getGlobalDispatcher } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { mediaTypeEssence } from "@modelcontextprotocol/sdk/shared/mediaType.js";
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  PromptListChangedNotificationSchema,
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  ToolSchema,
  ToolListChangedNotificationSchema,
  type Prompt,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config.ts";
import {
  validateResource,
  validateResourceTemplate,
  validateResourceUri,
} from "./resources.ts";
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

// Prompt identifiers are rendered in command UI and diagnostics, so bound them
// and reject control, format, and line-separator characters before they enter state.
const promptIdentifier = (value: string) =>
  Buffer.byteLength(value) > 0 &&
  Buffer.byteLength(value) <= 256 &&
  !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);

// Leave bounded room for the JSON-RPC envelope around a maximum-size result.
const MAX_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024 + 64 * 1024;

function responseLimitTransform(sse: boolean) {
  let responseBytes = 0;
  let eventBytes = 0;
  let lineBytes = 0;
  let previousCarriageReturn = false;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!sse) {
        responseBytes += chunk.byteLength;
        if (responseBytes > MAX_HTTP_RESPONSE_BYTES)
          throw new Error("MCP HTTP response exceeded the size limit.");
      } else {
        for (const byte of chunk) {
          eventBytes++;
          if (eventBytes > MAX_HTTP_RESPONSE_BYTES)
            throw new Error("MCP HTTP event exceeded the size limit.");
          if (byte === 0x0d) {
            if (lineBytes === 0) eventBytes = 0;
            lineBytes = 0;
            previousCarriageReturn = true;
          } else if (byte === 0x0a) {
            if (!previousCarriageReturn) {
              if (lineBytes === 0) eventBytes = 0;
              lineBytes = 0;
            }
            previousCarriageReturn = false;
          } else {
            previousCarriageReturn = false;
            lineBytes++;
          }
        }
      }
      controller.enqueue(chunk);
    },
  });
}

function boundedHttpResponse(response: Response): Response {
  if (!response.body) return response;
  const sse =
    mediaTypeEssence(response.headers.get("content-type")) ===
    "text/event-stream";
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    !sse &&
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_HTTP_RESPONSE_BYTES
  ) {
    void response.body.cancel();
    throw new Error("MCP HTTP response exceeded the size limit.");
  }
  return new Response(response.body.pipeThrough(responseLimitTransform(sse)), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class Connection {
  readonly client: Client;
  readonly config: ServerConfig;
  status = "Not connected";
  toolStatus = "Not discovered";
  promptStatus = "Not discovered";
  resourceStatus = "Not discovered";
  instructions = "";
  #transport: StdioClientTransport | StreamableHTTPClientTransport;
  #lifetime = new AbortController();
  #initializing: Promise<void> | undefined;
  #refreshing: Promise<void> | undefined;
  #promptRefreshing: Promise<void> | undefined;
  #resourceRefreshing: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #dirty = false;
  #promptDirty = false;
  #resourceDirty = false;
  #stopped = false;
  #connected = false;
  #toolsReady = false;
  #promptsReady = false;
  #resourcesReady = false;
  #resourcesSupported = false;
  #changed: (tools: Tool[]) => void;
  #promptsChanged: (prompts: Prompt[]) => void;
  #resourcesChanged: (
    resources: Resource[],
    templates: ResourceTemplate[],
  ) => void;
  #promptNames = new Set<string>();
  #outputValidators = new Map<string, ReturnType<typeof compileSchema>>();
  #operation = new AsyncLocalStorage<AbortSignal>();

  constructor(
    config: ServerConfig,
    changed: (tools: Tool[]) => void,
    promptsChanged: (prompts: Prompt[]) => void = () => {},
    resourcesChanged: (
      resources: Resource[],
      templates: ResourceTemplate[],
    ) => void = () => {},
  ) {
    this.config = config;
    this.#changed = changed;
    this.#promptsChanged = promptsChanged;
    this.#resourcesChanged = resourcesChanged;
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
    this.client.setNotificationHandler(
      PromptListChangedNotificationSchema,
      async () => {
        if (this.#stopped) return;
        try {
          await this.refreshPrompts();
        } catch {
          /* refresh already clears the stale catalog */
        }
      },
    );
    this.client.setNotificationHandler(
      ResourceListChangedNotificationSchema,
      async () => {
        if (this.#stopped) return;
        try {
          await this.refreshResources();
        } catch {
          /* refresh already clears the stale catalog */
        }
      },
    );
  }

  #disconnect() {
    if (this.#stopped || this.#lifetime.signal.aborted) return;
    this.status = "Disconnected; reload Pi to reconnect";
    this.toolStatus = "Unavailable";
    this.promptStatus = "Unavailable";
    this.resourceStatus = "Unavailable";
    this.#connected = false;
    this.#toolsReady = false;
    this.#promptsReady = false;
    this.#resourcesReady = false;
    this.#resourcesSupported = false;
    this.#lifetime.abort(
      new Error("MCP connection is unavailable; reload Pi to reconnect."),
    );
    this.#outputValidators.clear();
    this.#promptNames.clear();
    this.#changed([]);
    this.#promptsChanged([]);
    this.#resourcesChanged([], []);
    void this.client.close().catch(() => {});
  }

  #updateStatus() {
    if (!this.#connected || this.#stopped) return;
    const failures = [
      ...(!this.#toolsReady ? ["tool"] : []),
      ...(!this.#promptsReady ? ["prompt"] : []),
      ...(!this.#resourcesReady ? ["resource"] : []),
    ];
    if (failures.length === 0) this.status = "Connected";
    else if (failures.length < 3)
      this.status = `Connected; ${failures.join(" and ")} discovery failed`;
    else this.status = "Discovery failed; reload Pi to retry";
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
    if (init?.method === "DELETE")
      return boundedHttpResponse(await fetch(AbortSignal.timeout(2000)));
    const signals = [
      this.#lifetime.signal,
      ...(init?.signal ? [init.signal] : []),
    ];
    if (init?.method !== "GET") {
      // This body is generated by the SDK. Only our requests and the initialized
      // handshake notification belong to an operation. Incoming stream callbacks
      // retain their creator's async context: replies to server pings must not
      // inherit the already-finished handshake's abort signal. Cancellation and
      // other control messages also need their own short, lifetime-bound budget.
      const message =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const scoped =
        message &&
        (("method" in message && "id" in message) ||
          message.method === "notifications/initialized");
      const operation = scoped ? this.#operation.getStore() : undefined;
      return boundedHttpResponse(
        await fetch(
          AbortSignal.any([...signals, operation ?? AbortSignal.timeout(2000)]),
        ),
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
      const stream = responseLimitTransform(true);
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
      this.#connected = true;
      this.status = "Discovering";
      this.instructions = this.client.getInstructions() ?? "";
    } catch {
      if (!this.#stopped) {
        this.status =
          "Connection failed; check configuration/authentication and reload Pi";
        this.toolStatus = "Unavailable";
        this.promptStatus = "Unavailable";
        this.resourceStatus = "Unavailable";
        this.#changed([]);
        this.#promptsChanged([]);
        this.#resourcesChanged([], []);
      }
      await this.client.close().catch(() => {});
      throw new Error(`MCP server ${this.config.name}: connection failed.`);
    }
    const results = await Promise.allSettled([
      this.refresh(),
      this.refreshPrompts(),
      this.refreshResources(),
    ]);
    if (results.some((result) => result.status === "rejected"))
      throw new Error(`MCP server ${this.config.name}: discovery failed.`);
  }

  refresh(): Promise<void> {
    this.#dirty = true;
    this.#refreshing ??= this.#drainToolRefreshes();
    return this.#refreshing;
  }

  async #drainToolRefreshes(): Promise<void> {
    let failed = false;
    let failure: unknown;
    try {
      await this.#refresh();
    } catch (error) {
      failed = true;
      failure = error;
    }
    // Clear ownership and inspect dirty state without an await between them. A
    // notification queued as the prior refresh settles must start another pass.
    this.#refreshing = undefined;
    if (this.#dirty && !this.#stopped) return this.refresh();
    if (failed) throw failure;
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
              this.#toolsReady = true;
              this.toolStatus = "Available";
              this.#changed(tools);
              this.#updateStatus();
            }
          },
        );
      }
    } catch {
      if (!this.#stopped) {
        this.#toolsReady = false;
        this.toolStatus = "Discovery failed; reload Pi to retry";
        this.#outputValidators.clear();
        this.#changed([]);
        this.#updateStatus();
      }
      throw new Error(`MCP server ${this.config.name}: tool discovery failed.`);
    }
  }

  refreshPrompts(): Promise<void> {
    this.#promptDirty = true;
    this.#promptRefreshing ??= this.#drainPromptRefreshes();
    return this.#promptRefreshing;
  }

  async #drainPromptRefreshes(): Promise<void> {
    let failed = false;
    let failure: unknown;
    try {
      await this.#refreshPrompts();
    } catch (error) {
      failed = true;
      failure = error;
    }
    this.#promptRefreshing = undefined;
    if (this.#promptDirty && !this.#stopped) return this.refreshPrompts();
    if (failed) throw failure;
  }

  async #refreshPrompts(): Promise<void> {
    try {
      while (this.#promptDirty && !this.#stopped) {
        this.#promptDirty = false;
        const prompts: Prompt[] = [];
        const cursors = new Set<string>();
        const names = new Set<string>();
        const supportsPrompts = Boolean(
          this.client.getServerCapabilities()?.prompts,
        );
        let cursor: string | undefined;
        let bytes = 0;
        await this.#deadline(
          this.config.catalogTimeoutMs,
          undefined,
          async (signal) => {
            if (supportsPrompts) {
              do {
                const page = await this.#deadline(
                  this.config.catalogTimeoutMs,
                  signal,
                  (requestSignal) =>
                    this.client.request(
                      {
                        method: "prompts/list",
                        params: cursor === undefined ? {} : { cursor },
                      },
                      ListPromptsResultSchema,
                      {
                        signal: requestSignal,
                        timeout: this.config.catalogTimeoutMs,
                      },
                    ),
                );
                bytes += Buffer.byteLength(JSON.stringify(page));
                if (
                  bytes > 2 * 1024 * 1024 ||
                  prompts.length + page.prompts.length > 1000
                )
                  throw new Error("Catalog limit");
                for (const prompt of page.prompts) {
                  if (
                    !promptIdentifier(prompt.name) ||
                    Buffer.byteLength(prompt.title ?? "") > 16 * 1024 ||
                    Buffer.byteLength(prompt.description ?? "") > 16 * 1024 ||
                    (prompt.arguments?.length ?? 0) > 100
                  )
                    throw new Error("Invalid prompt metadata");
                  if (names.has(prompt.name))
                    throw new Error("Duplicate prompt name");
                  const argumentNames = new Set<string>();
                  for (const argument of prompt.arguments ?? []) {
                    if (
                      !promptIdentifier(argument.name) ||
                      Buffer.byteLength(argument.description ?? "") > 16 * 1024
                    )
                      throw new Error("Invalid prompt argument metadata");
                    if (argumentNames.has(argument.name))
                      throw new Error("Duplicate prompt argument name");
                    argumentNames.add(argument.name);
                  }
                  names.add(prompt.name);
                  prompts.push(prompt);
                }
                cursor = page.nextCursor;
                if (cursor !== undefined) {
                  if (cursors.has(cursor) || cursors.size >= 100)
                    throw new Error("Invalid pagination");
                  cursors.add(cursor);
                }
              } while (cursor !== undefined);
            }
            signal.throwIfAborted();
            if (!this.#stopped) {
              this.#promptNames = names;
              this.#promptsReady = true;
              this.promptStatus = supportsPrompts
                ? "Available"
                : "Not supported";
              this.#promptsChanged(prompts);
              this.#updateStatus();
            }
          },
        );
      }
    } catch {
      if (!this.#stopped) {
        this.#promptsReady = false;
        this.promptStatus = "Discovery failed; reload Pi to retry";
        this.#promptNames.clear();
        this.#promptsChanged([]);
        this.#updateStatus();
      }
      throw new Error(
        `MCP server ${this.config.name}: prompt discovery failed.`,
      );
    }
  }

  refreshResources(): Promise<void> {
    this.#resourceDirty = true;
    // Do not let picker selections remain current while either half of the
    // atomic resource/template snapshot is being refreshed.
    if (this.#resourcesReady) {
      this.#resourcesReady = false;
      this.resourceStatus = "Loading";
      this.#resourcesChanged([], []);
    }
    this.#resourceRefreshing ??= this.#drainResourceRefreshes();
    return this.#resourceRefreshing;
  }

  async #drainResourceRefreshes(): Promise<void> {
    let failed = false;
    let failure: unknown;
    try {
      await this.#refreshResources();
    } catch (error) {
      failed = true;
      failure = error;
    }
    this.#resourceRefreshing = undefined;
    if (this.#resourceDirty && !this.#stopped) return this.refreshResources();
    if (failed) throw failure;
  }

  async #refreshResources(): Promise<void> {
    try {
      while (this.#resourceDirty && !this.#stopped) {
        this.#resourceDirty = false;
        const resources: Resource[] = [];
        const templates: ResourceTemplate[] = [];
        const resourceCursors = new Set<string>();
        const templateCursors = new Set<string>();
        const uris = new Set<string>();
        const uriTemplates = new Set<string>();
        const supportsResources = Boolean(
          this.client.getServerCapabilities()?.resources,
        );
        let bytes = 0;
        await this.#deadline(
          this.config.catalogTimeoutMs,
          undefined,
          async (signal) => {
            if (supportsResources) {
              let cursor: string | undefined;
              do {
                const page = await this.#deadline(
                  this.config.catalogTimeoutMs,
                  signal,
                  (requestSignal) =>
                    this.client.request(
                      {
                        method: "resources/list",
                        params: cursor === undefined ? {} : { cursor },
                      },
                      ListResourcesResultSchema,
                      {
                        signal: requestSignal,
                        timeout: this.config.catalogTimeoutMs,
                      },
                    ),
                );
                bytes += Buffer.byteLength(JSON.stringify(page));
                if (
                  bytes > 2 * 1024 * 1024 ||
                  resources.length + templates.length + page.resources.length >
                    1000
                )
                  throw new Error("Catalog limit");
                for (const resource of page.resources) {
                  validateResource(resource);
                  if (uris.has(resource.uri))
                    throw new Error("Duplicate resource URI");
                  uris.add(resource.uri);
                  const catalogResource = { ...resource };
                  delete catalogResource._meta;
                  delete catalogResource.icons;
                  resources.push(catalogResource);
                }
                cursor = page.nextCursor;
                if (cursor !== undefined) {
                  if (
                    resourceCursors.has(cursor) ||
                    resourceCursors.size >= 100
                  )
                    throw new Error("Invalid pagination");
                  resourceCursors.add(cursor);
                }
              } while (cursor !== undefined);

              cursor = undefined;
              do {
                const page = await this.#deadline(
                  this.config.catalogTimeoutMs,
                  signal,
                  (requestSignal) =>
                    this.client.request(
                      {
                        method: "resources/templates/list",
                        params: cursor === undefined ? {} : { cursor },
                      },
                      ListResourceTemplatesResultSchema,
                      {
                        signal: requestSignal,
                        timeout: this.config.catalogTimeoutMs,
                      },
                    ),
                );
                bytes += Buffer.byteLength(JSON.stringify(page));
                if (
                  bytes > 2 * 1024 * 1024 ||
                  resources.length +
                    templates.length +
                    page.resourceTemplates.length >
                    1000
                )
                  throw new Error("Catalog limit");
                for (const template of page.resourceTemplates) {
                  validateResourceTemplate(template);
                  if (uriTemplates.has(template.uriTemplate))
                    throw new Error("Duplicate resource URI template");
                  uriTemplates.add(template.uriTemplate);
                  const catalogTemplate = { ...template };
                  delete catalogTemplate._meta;
                  delete catalogTemplate.icons;
                  templates.push(catalogTemplate);
                }
                cursor = page.nextCursor;
                if (cursor !== undefined) {
                  if (
                    templateCursors.has(cursor) ||
                    templateCursors.size >= 100
                  )
                    throw new Error("Invalid pagination");
                  templateCursors.add(cursor);
                }
              } while (cursor !== undefined);
            }
            signal.throwIfAborted();
            // One notification covers both list endpoints. Never publish a
            // cross-revision pair when it arrives between those requests.
            if (!this.#stopped && !this.#resourceDirty) {
              this.#resourcesReady = true;
              this.#resourcesSupported = supportsResources;
              this.resourceStatus = supportsResources
                ? "Available"
                : "Not supported";
              this.#resourcesChanged(resources, templates);
              this.#updateStatus();
            }
          },
        );
      }
    } catch {
      if (!this.#stopped) {
        this.#resourcesReady = false;
        this.#resourcesSupported = false;
        this.resourceStatus = "Discovery failed; reload Pi to retry";
        this.#resourcesChanged([], []);
        this.#updateStatus();
      }
      throw new Error(
        `MCP server ${this.config.name}: resource discovery failed.`,
      );
    }
  }

  async readResource(uri: string, signal?: AbortSignal) {
    await this.start().catch(() => {});
    const combined = signal
      ? AbortSignal.any([signal, this.#lifetime.signal])
      : this.#lifetime.signal;
    combined.throwIfAborted();
    if (!this.#resourcesReady)
      throw new Error(
        "MCP resource catalog is unavailable; reload Pi to retry.",
      );
    if (!this.#resourcesSupported)
      throw new Error("MCP server does not support resources.");
    validateResourceUri(uri);
    try {
      const result = await this.#deadline(
        this.config.timeout,
        combined,
        (requestSignal) =>
          this.client.request(
            { method: "resources/read", params: { uri } },
            ReadResourceResultSchema,
            {
              signal: requestSignal,
              timeout: this.config.timeout,
              resetTimeoutOnProgress: false,
            },
          ),
      );
      if (
        result.contents.length > 100 ||
        Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024
      )
        throw new Error("Resource result limit");
      return result;
    } catch {
      combined.throwIfAborted();
      throw new Error(
        `MCP server ${this.config.name}: resource request failed or timed out.`,
      );
    }
  }

  async getPrompt(
    name: string,
    args: Record<string, string> | undefined,
    signal?: AbortSignal,
  ) {
    await this.start().catch(() => {});
    const combined = signal
      ? AbortSignal.any([signal, this.#lifetime.signal])
      : this.#lifetime.signal;
    combined.throwIfAborted();
    if (!this.#promptsReady || !this.#promptNames.has(name))
      throw new Error("MCP prompt is unavailable; list prompts again.");
    if (args && Buffer.byteLength(JSON.stringify(args)) > 256 * 1024)
      throw new Error("MCP prompt arguments exceed 256 KiB.");
    try {
      return await this.#deadline(
        this.config.timeout,
        combined,
        (requestSignal) =>
          this.client.request(
            {
              method: "prompts/get",
              params: {
                name,
                ...(args && Object.keys(args).length > 0
                  ? { arguments: args }
                  : {}),
              },
            },
            GetPromptResultSchema,
            {
              signal: requestSignal,
              timeout: this.config.timeout,
              resetTimeoutOnProgress: false,
            },
          ),
      );
    } catch {
      combined.throwIfAborted();
      throw new Error(
        `MCP server ${this.config.name}: prompt request failed or timed out.`,
      );
    }
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    await this.start().catch(() => {});
    const combined = signal
      ? AbortSignal.any([signal, this.#lifetime.signal])
      : this.#lifetime.signal;
    combined.throwIfAborted();
    if (!this.#toolsReady)
      throw new Error("MCP tool catalog is unavailable; reload Pi to retry.");
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
    this.toolStatus = "Closed";
    this.promptStatus = "Closed";
    this.resourceStatus = "Closed";
    this.#toolsReady = false;
    this.#promptsReady = false;
    this.#resourcesReady = false;
    this.#resourcesSupported = false;
    this.#outputValidators.clear();
    this.#promptNames.clear();
    this.#changed([]);
    this.#promptsChanged([]);
    this.#resourcesChanged([], []);
    if (
      this.#transport instanceof StreamableHTTPClientTransport &&
      this.#transport.sessionId
    ) {
      await this.#transport.terminateSession().catch(() => {});
    }
    await this.client.close().catch(() => {});
    await this.#initializing?.catch(() => {});
    await this.#refreshing?.catch(() => {});
    await this.#promptRefreshing?.catch(() => {});
    await this.#resourceRefreshing?.catch(() => {});
  }
}
