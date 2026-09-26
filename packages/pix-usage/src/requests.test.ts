import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveUsage } from "./auth.ts";
import { UsageRequests } from "./requests.ts";
import type { UsageProvider, UsageResult } from "./types.ts";

vi.mock("./auth.ts", () => ({ resolveUsage: vi.fn() }));
const resolve = vi.mocked(resolveUsage);
const registry = { getProviderAuth: vi.fn() };
const cancelled: UsageResult = {
  provider: "claude",
  status: "error",
  message: "Usage request cancelled or timed out.",
};

function pending() {
  let finish!: (result: UsageResult) => void;
  const result = new Promise<UsageResult>((done) => {
    finish = done;
  });
  resolve.mockReturnValueOnce(result);
  return { result, finish };
}

function success(provider: UsageProvider = "claude"): UsageResult {
  return {
    provider,
    status: "ok",
    usage: { provider, fetchedAt: new Date(0).toISOString(), windows: [] },
  };
}

beforeEach(() => {
  resolve.mockReset();
});
afterEach(() => vi.restoreAllMocks());

test("shares only in-flight requests for the same provider", async () => {
  const requests = new UsageRequests();
  const first = pending();
  const signal = new AbortController().signal;
  const a = requests.get(registry, "claude", signal);
  const b = requests.get(registry, "claude", signal);
  expect(resolve).toHaveBeenCalledOnce();
  first.finish(success());
  expect(await a).toEqual(success());
  expect(await b).toEqual(success());

  resolve.mockResolvedValueOnce(success());
  expect(await requests.get(registry, "claude", signal)).toEqual(success());
  expect(resolve).toHaveBeenCalledTimes(2);
});

test("different providers resolve independently", async () => {
  const requests = new UsageRequests();
  const claude = pending();
  const codex = pending();
  const signal = new AbortController().signal;
  const a = requests.get(registry, "claude", signal);
  const b = requests.get(registry, "codex", signal);
  expect(resolve.mock.calls.map((call) => call[1])).toEqual([
    "claude",
    "codex",
  ]);
  codex.finish(success("codex"));
  expect(await b).toEqual(success("codex"));
  claude.finish(success());
  expect(await a).toEqual(success());
});

test("cancels a consumer without cancelling another consumer's request", async () => {
  const requests = new UsageRequests();
  const first = pending();
  const widget = new AbortController();
  const report = new AbortController();
  const a = requests.get(registry, "claude", widget.signal);
  const b = requests.get(registry, "claude", report.signal);
  const requestSignal = resolve.mock.calls[0]?.[2];
  widget.abort();
  expect(await a).toEqual(cancelled);
  expect(requestSignal?.aborted).toBe(false);
  first.finish(success());
  expect(await b).toEqual(success());
});

test("the last consumer cancels HTTP work and a late result cannot remove a newer request", async () => {
  const requests = new UsageRequests();
  const first = pending();
  const widget = new AbortController();
  const old = requests.get(registry, "claude", widget.signal);
  const requestSignal = resolve.mock.calls[0]?.[2];
  widget.abort();
  expect(await old).toEqual(cancelled);
  expect(requestSignal?.aborted).toBe(true);

  const second = pending();
  const signal = new AbortController().signal;
  const current = requests.get(registry, "claude", signal);
  first.finish(success());
  await first.result;
  const joined = requests.get(registry, "claude", signal);
  expect(resolve).toHaveBeenCalledTimes(2);
  second.finish(success());
  expect(await current).toEqual(success());
  expect(await joined).toEqual(success());
});

test("an already cancelled caller never starts credential resolution", async () => {
  const requests = new UsageRequests();
  expect(await requests.get(registry, "claude", AbortSignal.abort())).toEqual(
    cancelled,
  );
  expect(resolve).not.toHaveBeenCalled();
});

test("cancelAll aborts every provider and allows a new session to request again", async () => {
  const requests = new UsageRequests();
  // Emulate resolveUsage's normalized cancellation response.
  resolve.mockImplementation(async (_registry, provider, signal) => {
    await new Promise<void>((done) =>
      signal.addEventListener("abort", () => done(), { once: true }),
    );
    return { ...cancelled, provider };
  });
  const signal = new AbortController().signal;
  const a = requests.get(registry, "claude", signal);
  const b = requests.get(registry, "codex", signal);
  const signals = resolve.mock.calls.map((call) => call[2]);
  requests.cancelAll();
  requests.cancelAll();
  expect(signals.every((value) => value.aborted)).toBe(true);
  await Promise.all([a, b]);
  resolve.mockResolvedValueOnce(success());
  expect(await requests.get(registry, "claude", signal)).toEqual(success());
  expect(resolve).toHaveBeenCalledTimes(3);
});

test("the shared request has a total deadline including credential resolution", async () => {
  const timeout = new AbortController();
  const deadline = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(timeout.signal);
  const requests = new UsageRequests();
  resolve.mockImplementation(async (_registry, _provider, signal) => {
    await new Promise<void>((done) =>
      signal.addEventListener("abort", () => done(), { once: true }),
    );
    return cancelled;
  });
  const result = requests.get(registry, "claude", new AbortController().signal);
  expect(deadline).toHaveBeenCalledExactlyOnceWith(20_000);
  timeout.abort();
  expect(await result).toEqual(cancelled);
});
