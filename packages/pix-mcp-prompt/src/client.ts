import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { McpClient, type McpTransport } from "@earendil-works/pi-mcp";
import {
  VERSION,
  type ExtensionContext,
  type McpServerEntry,
} from "@earendil-works/pi-coding-agent";
import { createNativeTransport } from "./native.ts";
import {
  MAX_PROMPT_ARGUMENT_BYTES,
  MAX_PROMPT_CATALOG_BYTES,
  MAX_PROMPT_CURSORS,
  MAX_PROMPTS,
  parseGetPromptResult,
  parseListPromptsResult,
  type GetPromptResult,
  type Prompt,
} from "./protocol.ts";

interface NativeTransport {
  transport: McpTransport;
  settled: () => Promise<void>;
}

interface OwnedClient extends NativeTransport {
  client: McpClient;
  generation: number;
  closing?: Promise<void>;
}

function waitWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function jsonBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized);
  } catch {
    return undefined;
  }
}

export class Connection {
  readonly entry: McpServerEntry;
  promptStatus = "Not discovered";

  readonly #ctx: ExtensionContext;
  readonly #changed: (prompts: Prompt[]) => void;
  readonly #lifetime = new AbortController();
  #active: OwnedClient | undefined;
  #connectingClient: McpClient | undefined;
  #connectingOwner: OwnedClient | undefined;
  #starting: Promise<void> | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshOwner: OwnedClient | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;
  #generation = 0;
  #dirty = false;
  #catalogReady = false;
  #promptNames = new Set<string>();

  constructor(
    entry: McpServerEntry,
    ctx: ExtensionContext,
    changed: (prompts: Prompt[]) => void,
  ) {
    this.entry = entry;
    this.#ctx = ctx;
    this.#changed = changed;
  }

  start(): Promise<void> {
    if (this.#closed)
      return Promise.reject(
        new Error(`MCP server ${this.entry.name}: connection is closed.`),
      );
    if (
      this.#active?.client.connectionState === "connected" &&
      this.#catalogReady
    )
      return Promise.resolve();
    if (this.#starting) return this.#starting;
    const operation = this.#start();
    const shared = operation.finally(() => {
      if (this.#starting === shared) this.#starting = undefined;
    });
    this.#starting = shared;
    return shared;
  }

  async #start(): Promise<void> {
    let owner = this.#active;
    if (!owner || owner.client.connectionState !== "connected") {
      owner = await this.#connect();
    }
    if (!this.#catalogReady) await this.#schedulePromptRefresh(owner);
  }

  async #connect(): Promise<OwnedClient> {
    const generation = ++this.#generation;
    this.promptStatus = "Connecting";
    const client = new McpClient({
      name: "pi",
      version: VERSION,
      requestTimeoutMs: (this.entry.config.timeout ?? 60) * 1_000,
      roots: [
        {
          uri: pathToFileURL(this.#ctx.cwd).href,
          name: basename(this.#ctx.cwd),
        },
      ],
    });
    this.#connectingClient = client;
    let owner: OwnedClient | undefined;
    const nativePromise = createNativeTransport(this.entry, this.#ctx);
    // The adapter has no cancellation input. If shutdown wins the race, close
    // any transport it eventually creates instead of leaving it orphaned.
    void nativePromise.then(
      (native) => {
        if (
          this.#closed ||
          generation !== this.#generation ||
          this.#connectingClient !== client
        )
          void this.#closeUnconnected(native);
      },
      () => {},
    );

    try {
      const native = await waitWithSignal(nativePromise, this.#lifetime.signal);
      this.#lifetime.signal.throwIfAborted();
      if (generation !== this.#generation || this.#connectingClient !== client)
        throw new Error("Connection ownership changed");
      owner = { ...native, client, generation };
      this.#connectingOwner = owner;
      client.onNotification("notifications/prompts/list_changed", () => {
        this.#handleListChanged(owner as OwnedClient);
      });
      client.onClose(() => this.#handleClientClose(owner as OwnedClient));
      await client.connect(native.transport);
      this.#lifetime.signal.throwIfAborted();
      if (
        generation !== this.#generation ||
        this.#connectingOwner !== owner ||
        client.connectionState !== "connected"
      )
        throw new Error("Connection ownership changed");
      this.#active = owner;
      this.#connectingClient = undefined;
      this.#connectingOwner = undefined;
      this.#catalogReady = false;
      this.promptStatus = "Discovering";
      return owner;
    } catch {
      if (this.#connectingClient === client) this.#connectingClient = undefined;
      if (this.#connectingOwner === owner) this.#connectingOwner = undefined;
      if (owner) await this.#closeOwner(owner);
      else await client.close().catch(() => {});
      if (!this.#closed && generation === this.#generation) {
        this.#clearCatalog();
        this.promptStatus = "Connection failed; retry on next use";
      }
      throw new Error(`MCP server ${this.entry.name}: connection failed.`);
    }
  }

  #handleClientClose(owner: OwnedClient): void {
    if (this.#closed || this.#active !== owner) return;
    this.#active = undefined;
    this.#generation++;
    this.#dirty = false;
    this.#clearCatalog();
    this.promptStatus = "Disconnected; reconnect on next use";
    void this.#closeOwner(owner);
  }

  #handleListChanged(owner: OwnedClient): void {
    if (this.#closed || this.#active !== owner) return;
    void this.#schedulePromptRefresh(owner).catch(() => {
      /* Discovery failure already withdrew the stale catalog. */
    });
  }

  refreshPrompts(): Promise<void> {
    if (this.#closed)
      return Promise.reject(
        new Error(`MCP server ${this.entry.name}: connection is closed.`),
      );
    const owner = this.#active;
    if (!owner || owner.client.connectionState !== "connected")
      return this.start();
    return this.#schedulePromptRefresh(owner);
  }

  #schedulePromptRefresh(owner: OwnedClient): Promise<void> {
    if (this.#closed || this.#active !== owner)
      return Promise.reject(
        new Error(`MCP server ${this.entry.name}: prompt discovery failed.`),
      );
    if (this.#refreshing) {
      if (this.#refreshOwner === owner) {
        this.#dirty = true;
        this.#invalidateCatalog();
        return this.#refreshing;
      }
      const previous = this.#refreshing;
      return previous
        .catch(() => {})
        .then(() => this.#schedulePromptRefresh(owner));
    }
    this.#dirty = true;
    this.#invalidateCatalog();
    this.#refreshOwner = owner;
    this.#refreshing = this.#drainPromptRefreshes(owner);
    return this.#refreshing;
  }

  async #drainPromptRefreshes(owner: OwnedClient): Promise<void> {
    let failure: unknown;
    try {
      await this.#refreshPromptLoop(owner);
    } catch (error) {
      failure = error;
      if (!this.#closed && this.#active === owner) {
        this.#clearCatalog();
        this.promptStatus = "Discovery failed; retry on next use";
      }
    }
    if (this.#refreshOwner === owner) {
      this.#refreshing = undefined;
      this.#refreshOwner = undefined;
    }
    if (this.#dirty && !this.#closed && this.#active === owner)
      return this.#schedulePromptRefresh(owner);
    if (failure)
      throw new Error(
        `MCP server ${this.entry.name}: prompt discovery failed.`,
      );
  }

  async #refreshPromptLoop(owner: OwnedClient): Promise<void> {
    while (this.#dirty && !this.#closed && this.#active === owner) {
      this.#dirty = false;
      const supportsPrompts =
        owner.client.serverCapabilities?.prompts !== undefined;
      if (!supportsPrompts) {
        if (!this.#dirty && this.#owns(owner)) {
          this.#promptNames = new Set();
          this.#catalogReady = true;
          this.promptStatus = "Not supported";
          this.#emit([]);
        }
        continue;
      }

      const prompts: Prompt[] = [];
      const names = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let bytes = 0;
      do {
        const raw = await owner.client.request<unknown>(
          "prompts/list",
          cursor === undefined ? undefined : { cursor },
          { onProgress: () => {} },
        );
        const pageBytes = jsonBytes(raw);
        if (pageBytes === undefined) throw new Error("Invalid catalog");
        bytes += pageBytes;
        if (bytes > MAX_PROMPT_CATALOG_BYTES)
          throw new Error("Catalog size limit");
        const page = parseListPromptsResult(raw);
        if (prompts.length + page.prompts.length > MAX_PROMPTS)
          throw new Error("Catalog entry limit");
        for (const prompt of page.prompts) {
          if (names.has(prompt.name)) throw new Error("Duplicate prompt name");
          names.add(prompt.name);
          prompts.push(prompt);
        }
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (cursors.has(cursor) || cursors.size >= MAX_PROMPT_CURSORS)
            throw new Error("Invalid pagination");
          cursors.add(cursor);
        }
      } while (cursor !== undefined);

      // A notification during pagination makes this snapshot stale. The loop
      // drains that dirty revision before anything becomes selectable again.
      if (!this.#dirty && this.#owns(owner)) {
        this.#promptNames = names;
        this.#catalogReady = true;
        this.promptStatus = "Available";
        this.#emit(prompts);
      }
    }
  }

  async getPrompt(
    name: string,
    args: Record<string, string> | undefined,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> {
    signal?.throwIfAborted();
    await (signal ? waitWithSignal(this.start(), signal) : this.start());
    signal?.throwIfAborted();
    const owner = this.#active;
    if (
      !owner ||
      owner.client.connectionState !== "connected" ||
      !this.#catalogReady ||
      !this.#promptNames.has(name)
    )
      throw new Error("MCP prompt is unavailable; list prompts again.");

    if (args !== undefined) {
      if (
        args === null ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        Object.values(args).some((value) => typeof value !== "string")
      )
        throw new Error("MCP prompt arguments are invalid.");
      const bytes = jsonBytes(args);
      if (bytes === undefined)
        throw new Error("MCP prompt arguments are invalid.");
      if (bytes > MAX_PROMPT_ARGUMENT_BYTES)
        throw new Error("MCP prompt arguments exceed 256 KiB.");
    }

    const combined = signal
      ? AbortSignal.any([signal, this.#lifetime.signal])
      : this.#lifetime.signal;
    combined.throwIfAborted();
    try {
      // Do not retry: a response can be lost after the server rendered a prompt.
      const result = await owner.client.request<unknown>(
        "prompts/get",
        {
          name,
          ...(args && Object.keys(args).length > 0 ? { arguments: args } : {}),
        },
        { signal: combined, onProgress: () => {} },
      );
      return parseGetPromptResult(result);
    } catch {
      combined.throwIfAborted();
      throw new Error(
        `MCP server ${this.entry.name}: prompt request failed or timed out. It may already have completed; do not retry blindly.`,
      );
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#generation++;
    this.#lifetime.abort(new Error("MCP connection closed."));
    this.#dirty = false;
    this.#clearCatalog();
    this.promptStatus = "Closed";

    const active = this.#active;
    const connectingOwner = this.#connectingOwner;
    const connectingClient = this.#connectingClient;
    this.#active = undefined;
    this.#connectingOwner = undefined;
    this.#connectingClient = undefined;
    await Promise.all([
      active ? this.#closeOwner(active) : undefined,
      connectingOwner && connectingOwner !== active
        ? this.#closeOwner(connectingOwner)
        : undefined,
      connectingClient && connectingClient !== connectingOwner?.client
        ? connectingClient.close().catch(() => {})
        : undefined,
    ]);
    await this.#starting?.catch(() => {});
    await this.#refreshing?.catch(() => {});
  }

  #owns(owner: OwnedClient): boolean {
    return (
      !this.#closed &&
      this.#active === owner &&
      owner.generation === this.#generation &&
      owner.client.connectionState === "connected"
    );
  }

  #invalidateCatalog(): void {
    const hadCatalog = this.#catalogReady || this.#promptNames.size > 0;
    this.#catalogReady = false;
    this.#promptNames.clear();
    this.promptStatus = "Loading";
    if (hadCatalog) this.#emit([]);
  }

  #clearCatalog(): void {
    this.#catalogReady = false;
    this.#promptNames.clear();
    this.#emit([]);
  }

  #emit(prompts: Prompt[]): void {
    try {
      this.#changed(prompts);
    } catch {
      /* A UI callback must not compromise connection ownership or shutdown. */
    }
  }

  #closeOwner(owner: OwnedClient): Promise<void> {
    owner.closing ??= (async () => {
      await owner.client.close().catch(() => {});
      await owner.settled().catch(() => {});
    })();
    return owner.closing;
  }

  async #closeUnconnected(native: NativeTransport): Promise<void> {
    await native.transport.close().catch(() => {});
    await native.settled().catch(() => {});
  }
}
