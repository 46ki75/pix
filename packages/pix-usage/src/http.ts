import { UsageError } from "./types.ts";

export const MAX_RESPONSE_BYTES = 256 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;

export interface FetchOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// Pi's auth resolver has no per-call cancellation on the extension facade. Stop
// waiting without interfering with the refresh/credential lock owned by Pi.
export function abortable<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

export async function getJson(
  url: string,
  headers: Record<string, string>,
  options: FetchOptions = {},
): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  try {
    signal.throwIfAborted();
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json", ...headers },
      signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) {
        throw new UsageError(
          "auth",
          `Usage access denied (HTTP ${response.status}); check your subscription login and OAuth scopes.`,
        );
      }
      if (response.status === 429) {
        throw new UsageError(
          "rate-limit",
          "Usage endpoint rate limited (HTTP 429); wait before retrying.",
        );
      }
      throw new UsageError(
        "http",
        `Usage request failed (HTTP ${response.status}).`,
      );
    }
    if (!response.body)
      throw new UsageError("response", "Empty usage response.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      while (true) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          throw new UsageError(
            "response",
            "Usage response exceeded the size limit.",
          );
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new UsageError("response", "Invalid JSON usage response.");
      }
    } finally {
      signal.removeEventListener("abort", abort);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (timeout.aborted)
      throw new UsageError("timeout", "Usage request timed out.");
    if (error instanceof UsageError) throw error;
    // Fetch exceptions and remote error bodies can contain credentials.
    throw new UsageError("network", "Usage network request failed.");
  }
}
