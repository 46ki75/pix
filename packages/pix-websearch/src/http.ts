import { SearchError } from "./types.ts";

export const MAX_RESPONSE_BYTES = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 25_000;

export interface HttpOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SearchError("Invalid search response.");
  }
  return value as Record<string, unknown>;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SearchError("Invalid JSON search response.");
  }
}

// These hosted endpoints accept direct tools/call requests. This is deliberately
// endpoint-specific, not a general MCP client with lifecycle/session negotiation.
export function createHttp(options: HttpOptions = {}) {
  const fetch = options.fetch ?? globalThis.fetch;
  const byteLimit = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  let requestId = 0;

  async function post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    rpcId?: number,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(
      options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    );
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      requestSignal.throwIfAborted();
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "User-Agent": "pix-websearch/0.0.0",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new SearchError(
          response.status === 429
            ? "Search rate limited (HTTP 429)."
            : `Search request failed (HTTP ${response.status}).`,
          {
            status: response.status,
            retryAfter: response.headers.get("retry-after") ?? "",
          },
        );
      }
      if (!response.body) throw new SearchError("Empty search response.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const sse = response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("text/event-stream");
      let bytes = 0;
      let text = "";
      const events =
        sse && rpcId !== undefined ? new RpcEvents(rpcId) : undefined;
      // Cancel body consumption too: fetch resolving only means headers arrived.
      const abort = () => {
        void reader.cancel().catch(() => {});
      };
      requestSignal.addEventListener("abort", abort, { once: true });
      try {
        requestSignal.throwIfAborted();
        while (true) {
          const chunk = await reader.read();
          requestSignal.throwIfAborted();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > byteLimit) {
            throw new SearchError(
              `Search response exceeded ${byteLimit} bytes.`,
            );
          }
          const decoded = decoder.decode(chunk.value, { stream: true });
          if (events) {
            const result = events.push(decoded);
            if (result !== undefined) return result;
          } else {
            text += decoded;
          }
        }
        const tail = decoder.decode();
        if (events) {
          const result = events.push(`${tail}\n\n`);
          if (result !== undefined) return result;
          throw new SearchError("Missing MCP search response.");
        }
        const value = parseJson(text + tail);
        if (rpcId === undefined) return value;
        const result = rpcResult(value, rpcId);
        if (result === undefined)
          throw new SearchError("Missing MCP search response.");
        return result;
      } finally {
        requestSignal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timeout.aborted) throw new SearchError("Search request timed out.");
      if (error instanceof SearchError) throw error;
      // Do not expose fetch errors or remote error bodies: they can include keys.
      throw new SearchError("Search network request failed.");
    }
  }

  return {
    postJson(
      url: string,
      body: unknown,
      headers: Record<string, string>,
      signal?: AbortSignal,
    ) {
      return post(url, body, headers, signal);
    },
    async callMcp(
      url: string,
      tool: string,
      args: Record<string, unknown>,
      headers: Record<string, string>,
      signal?: AbortSignal,
    ) {
      const id = ++requestId;
      return record(
        await post(
          url,
          {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: tool, arguments: args },
          },
          headers,
          signal,
          id,
        ),
      );
    },
  };
}

export type Http = ReturnType<typeof createHttp>;

function rpcResult(
  value: unknown,
  id: number,
): Record<string, unknown> | undefined {
  const message = record(value);
  if (message.jsonrpc !== "2.0")
    throw new SearchError("Invalid MCP search response.");
  if (message.id !== id) return undefined;
  if (message.error !== undefined)
    throw new SearchError("Search provider returned an MCP error.");
  const result = record(message.result);
  if (result.isError === true)
    throw new SearchError("Search provider reported a tool error.");
  return result;
}

class RpcEvents {
  private buffer = "";
  private data: string[] = [];

  constructor(private readonly id: number) {}

  push(chunk: string): Record<string, unknown> | undefined {
    this.buffer += chunk;
    while (true) {
      // Hold a trailing CR until the next chunk so CRLF counts as one newline.
      const ending = /\r\n|\n|\r(?!$)/.exec(this.buffer);
      if (!ending) return undefined;
      const line = this.buffer.slice(0, ending.index);
      this.buffer = this.buffer.slice(ending.index + ending[0].length);
      if (!line) {
        const payload = this.data.join("\n").trim();
        this.data = [];
        if (!payload || payload === "[DONE]") continue;
        const result = rpcResult(parseJson(payload), this.id);
        if (result !== undefined) return result;
      } else if (line === "data" || line.startsWith("data:")) {
        this.data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
}
