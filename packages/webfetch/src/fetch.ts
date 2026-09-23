import { TextDecoder } from "node:util";

export const MAX_URL_LENGTH = 8_192;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 25_000;
export const MAX_REDIRECTS = 5;

export interface FetchedPage {
  url: string;
  contentType: string;
  text: string;
  responseBytes: number;
}

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

interface FetchOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export function createWebFetch(options: FetchOptions = {}) {
  const fetch = options.fetch ?? globalThis.fetch;
  const byteLimit = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;

  return async (input: string, signal?: AbortSignal): Promise<FetchedPage> => {
    signal?.throwIfAborted();
    let url = parseUrl(input);
    const timeout = AbortSignal.timeout(
      options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    );
    // One deadline covers every redirect and the final body read.
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const visited = new Set<string>();

    try {
      for (let redirects = 0; ; redirects++) {
        requestSignal.throwIfAborted();
        if (visited.has(url.href))
          throw new FetchError("Web fetch redirect loop.");
        visited.add(url.href);

        const response = await fetch(url.href, {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept:
              "text/html, application/xhtml+xml, text/plain, text/markdown, application/json, application/xml;q=0.9, */*;q=0.1",
            "User-Agent": "pix-webfetch/0.0.0",
          },
          signal: requestSignal,
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          if (redirects >= MAX_REDIRECTS) {
            throw new FetchError(
              `Web fetch exceeded ${MAX_REDIRECTS} redirects.`,
            );
          }
          const location = response.headers.get("location");
          if (!location)
            throw new FetchError("Web fetch redirect is missing a location.");
          url = parseUrl(location, url);
          continue;
        }

        if (!response.ok) {
          await response.body?.cancel();
          throw new FetchError(`Web fetch failed (HTTP ${response.status}).`);
        }

        try {
          const { contentType, decoder } = decodeOptions(response.headers);
          const { text, responseBytes } = await readBody(
            response,
            decoder,
            byteLimit,
            requestSignal,
          );
          if (text.includes("\0"))
            throw new FetchError(
              "Web fetch received binary content instead of text.",
            );
          return { url: url.href, contentType, text, responseBytes };
        } finally {
          // Also release bodies rejected before reading (unsupported MIME/charset).
          await response.body?.cancel().catch(() => {});
        }
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (timeout.aborted) throw new FetchError("Web fetch timed out.");
      if (error instanceof FetchError) throw error;
      // Native errors and server error bodies may expose URL credentials/tokens.
      throw new FetchError("Web fetch network request failed.");
    }
  };
}

function parseUrl(input: string, base?: URL): URL {
  try {
    if (!input.trim() || input.length > MAX_URL_LENGTH) throw new Error();
    const url = new URL(input, base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
    url.hash = "";
    if (Buffer.byteLength(url.href) > MAX_URL_LENGTH) throw new Error();
    return url;
  } catch {
    throw new FetchError(
      `Web fetch requires an HTTP(S) URL without credentials, at most ${MAX_URL_LENGTH} bytes.`,
    );
  }
}

function decodeOptions(headers: Headers) {
  const header = headers.get("content-type") ?? "text/plain";
  const contentType =
    header.split(";", 1)[0]?.trim().toLowerCase() || "text/plain";
  if (
    !(
      contentType.startsWith("text/") ||
      /^application\/(?:json|xml|xhtml\+xml|yaml|x-yaml|javascript|[a-z0-9.+-]+\+(?:json|xml))$/.test(
        contentType,
      )
    )
  ) {
    throw new FetchError(
      "Web fetch supports HTML and text formats; this response has an unsupported content type.",
    );
  }
  const charset = /;\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))/i.exec(
    header,
  );
  try {
    return {
      contentType,
      decoder: new TextDecoder(
        charset?.[1] ?? charset?.[2] ?? charset?.[3] ?? "utf-8",
      ),
    };
  } catch {
    throw new FetchError(
      "Web fetch received an unsupported character encoding.",
    );
  }
}

async function readBody(
  response: Response,
  decoder: TextDecoder,
  byteLimit: number,
  signal: AbortSignal,
): Promise<{ text: string; responseBytes: number }> {
  signal.throwIfAborted();
  if (!response.body) return { text: "", responseBytes: 0 };
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  let text = "";
  let responseBytes = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      // Fetch exposes decompressed bytes; Content-Length can describe compressed data.
      responseBytes += chunk.value.byteLength;
      if (responseBytes > byteLimit)
        throw new FetchError(`Web fetch response exceeded ${byteLimit} bytes.`);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return { text: text + decoder.decode(), responseBytes };
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
