import { afterEach, expect, test, vi } from "vitest";
import { abortable, getJson, MAX_RESPONSE_BYTES } from "./http.ts";

const URL = "https://api.anthropic.com/api/oauth/usage";
const HEADERS = { Authorization: "Bearer secret-token" };

afterEach(() => vi.restoreAllMocks());

test("reads bounded JSON even when UTF-8 code points cross chunks", async () => {
  const bytes = new TextEncoder().encode('{"label":"週"}');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(body));
  await expect(getJson(URL, HEADERS, { fetch })).resolves.toEqual({
    label: "週",
  });
});

test.each([
  [401, "Usage access denied (HTTP 401)"],
  [403, "Usage access denied (HTTP 403)"],
  [429, "Usage endpoint rate limited (HTTP 429)"],
  [500, "Usage request failed (HTTP 500)"],
  [302, "Usage request failed (HTTP 302)"],
] as const)(
  "sanitizes HTTP %s errors, cancels the body, and never retries",
  async (status, message) => {
    const response = new Response("secret-token and remote error details", {
      status,
    });
    const cancel = vi.spyOn(
      response.body as NonNullable<Response["body"]>,
      "cancel",
    );
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const result = getJson(URL, HEADERS, { fetch });
    await expect(result).rejects.toThrow(message);
    await expect(result).rejects.not.toThrow("secret-token");
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
  },
);

test("does not expose errors from fetch or body consumption", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(new Error("secret-token"));
  await expect(getJson(URL, HEADERS, { fetch })).rejects.toThrow(
    "Usage network request failed.",
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("secret-token"));
    },
  });
  fetch.mockResolvedValue(new Response(body));
  await expect(getJson(URL, HEADERS, { fetch })).rejects.toThrow(
    "Usage network request failed.",
  );
});

test.each(["secret-token not json", ""])(
  "rejects invalid JSON without echoing it",
  async (body) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(body));
    await expect(getJson(URL, HEADERS, { fetch })).rejects.toThrow(
      "Invalid JSON usage response.",
    );
  },
);

test("rejects an empty body", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(null));
  await expect(getJson(URL, HEADERS, { fetch })).rejects.toThrow(
    "Empty usage response.",
  );
});

test("rejects an oversized streamed body and releases its reader", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1));
    },
    cancel,
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(body));
  await expect(getJson(URL, HEADERS, { fetch })).rejects.toThrow(
    "Usage response exceeded the size limit.",
  );
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

test("already-cancelled calls never send credentials", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const reason = new Error("cancelled");
  await expect(
    getJson(URL, HEADERS, { fetch, signal: AbortSignal.abort(reason) }),
  ).rejects.toBe(reason);
  expect(fetch).not.toHaveBeenCalled();
});

test.each(["cancel", "timeout"] as const)(
  "%s covers stalled response bodies, not just headers",
  async (kind) => {
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    if (kind === "timeout")
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(body));
    const result = getJson(URL, HEADERS, {
      fetch,
      ...(kind === "cancel" ? { signal: controller.signal } : {}),
    });
    const check = expect(result).rejects.toThrow(
      kind === "timeout" ? "Usage request timed out." : "cancelled",
    );
    await started;
    controller.abort(new Error("cancelled"));
    await check;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  },
);

test("timeout also covers a fetch that has not received headers", async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("secret-token")),
          { once: true },
        );
      }),
  );
  const result = getJson(URL, HEADERS, { fetch });
  const check = expect(result).rejects.toThrow("Usage request timed out.");
  controller.abort();
  await check;
});

test("abortable stops waiting for auth without unhandled late rejection", async () => {
  const controller = new AbortController();
  let reject!: (error: Error) => void;
  const task = new Promise<never>((_resolve, rejectTask) => {
    reject = rejectTask;
  });
  const result = abortable(task, controller.signal);
  const check = expect(result).rejects.toThrow("cancelled");
  controller.abort(new Error("cancelled"));
  await check;
  reject(new Error("late auth failure"));
  await Promise.resolve();
});

test("abortable passes through success/failure and observes prior cancellation", async () => {
  const signal = new AbortController().signal;
  await expect(abortable(Promise.resolve(123), signal)).resolves.toBe(123);
  await expect(
    abortable(Promise.reject(new Error("failed")), signal),
  ).rejects.toThrow("failed");
  const aborted = AbortSignal.abort(new Error("cancelled"));
  await expect(abortable(Promise.resolve(123), aborted)).rejects.toThrow(
    "cancelled",
  );
});
