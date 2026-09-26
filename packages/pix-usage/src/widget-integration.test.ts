import { stripVTControlCharacters } from "node:util";
import {
  createExtensionRuntime,
  type Extension,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionContextActions,
  ExtensionRunner,
  type ExtensionUIContext,
  type ModelSelectEvent,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import subscriptionUsage from "./index.ts";

const NOW = Date.parse("2026-09-25T00:00:00Z");
const MINUTE = 60_000;
const REFRESH = 5 * MINUTE;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type ResolveAuth = ExtensionCommandContext["modelRegistry"]["getProviderAuth"];
type Widget = Component & { dispose?(): void };
const codexToken = `header.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
  }),
).toString("base64url")}.sig`;

function harness(
  provider: string | undefined = "anthropic",
  mode: ExtensionContext["mode"] = "tui",
) {
  let widget: Widget | undefined;
  let command!: Command;
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => void
  >();
  const requestRender = vi.fn();
  const notify = vi.fn<ExtensionUIContext["notify"]>();
  const setWidget = vi.fn(
    (
      _key: string,
      factory: ((tui: { requestRender: () => void }) => Widget) | undefined,
      _options?: unknown,
    ) => {
      widget?.dispose?.();
      widget = factory?.({ requestRender });
    },
  );
  const getProviderAuth = vi
    .fn<ResolveAuth>()
    .mockImplementation(async (id) => ({
      source: "OAuth",
      auth: { apiKey: id === "anthropic" ? "claude-test-token" : codexToken },
    }));
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (url) =>
      String(url).includes("anthropic.com")
        ? Response.json({
            five_hour: {
              utilization: 12,
              resets_at: new Date(NOW + 5 * 60 * MINUTE).toISOString(),
            },
          })
        : Response.json({
            rate_limit: {
              primary_window: {
                used_percent: 93,
                limit_window_seconds: 604800,
              },
            },
          }),
    );
  vi.stubGlobal("fetch", fetch);
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    model: provider ? { provider, id: "test-model" } : undefined,
    modelRegistry: { getProviderAuth },
    ui: {
      setWidget,
      notify,
      theme: {
        fg: (_color: string, text: string) => text,
        getFgAnsi: () => "",
      },
    },
  } as unknown as ExtensionCommandContext;
  const api = {
    registerCommand: (_name: string, registration: Command) => {
      command = registration;
    },
    on: (
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => void,
    ) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  } as unknown as ExtensionAPI;
  subscriptionUsage(api);
  const select = (id: string) => {
    ctx.model = { provider: id, id: "test-model" } as NonNullable<
      ExtensionContext["model"]
    >;
    handlers.get("model_select")?.(
      { type: "model_select", model: { provider: id } },
      ctx,
    );
  };
  const shutdown = () =>
    handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "reload" },
      ctx,
    );
  return {
    command,
    ctx,
    handlers,
    select,
    start: () =>
      handlers.get("session_start")?.({ type: "session_start" }, ctx),
    turnEnd: () => handlers.get("turn_end")?.({ type: "turn_end" }, ctx),
    shutdown,
    getProviderAuth,
    fetch,
    requestRender,
    notify,
    setWidget,
    get widget() {
      return widget;
    },
    text: () => stripVTControlCharacters(widget?.render(120).join("\n") ?? ""),
    toggle: () => command.handler("toggle", ctx),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const flush = () => vi.advanceTimersByTimeAsync(0);

test("does no work at extension load or before session_start; completes toggle", async () => {
  const h = harness();
  h.select("openai-codex");
  h.turnEnd();
  await vi.advanceTimersByTimeAsync(REFRESH * 2);
  expect(h.getProviderAuth).not.toHaveBeenCalled();
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.setWidget).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(h.command.getArgumentCompletions?.("t")).toEqual([
    { value: "toggle", label: "toggle" },
  ]);
});

test.each(["anthropic", "openai-codex"])(
  "session_start shows %s by default; toggle hides it until explicitly shown again",
  async (provider) => {
    const h = harness(provider);
    h.start();
    expect(h.setWidget).toHaveBeenCalledExactlyOnceWith(
      "pix-usage",
      expect.any(Function),
      { placement: "aboveEditor" },
    );
    await flush();
    expect(h.getProviderAuth).toHaveBeenCalledExactlyOnceWith(provider);
    expect(h.text()).toContain(provider === "anthropic" ? "Claude" : "Codex");
    expect(h.notify).not.toHaveBeenCalled();

    await h.toggle();
    expect(h.widget).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    h.select(provider === "anthropic" ? "openai-codex" : "anthropic");
    await vi.advanceTimersByTimeAsync(REFRESH * 2);
    expect(h.widget).toBeUndefined();
    expect(h.getProviderAuth).toHaveBeenCalledOnce();
    await h.toggle();
    await flush();
    expect(h.text()).toContain(provider === "anthropic" ? "Codex" : "Claude");
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.notify.mock.calls).toEqual([
      ["Usage widget hidden.", "info"],
      ["Usage widget shown.", "info"],
    ]);
    h.shutdown();
  },
);

test("a new session restores default visibility after the user hides the widget", async () => {
  const h = harness();
  h.start();
  await flush();
  await h.toggle();
  h.shutdown();
  h.start();
  await flush();
  expect(h.text()).toContain("Claude");
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(2);
  h.shutdown();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["openai", undefined])(
  "startup with provider %s shows an explanatory widget without requests",
  async (provider) => {
    const h = harness(provider);
    if (provider === undefined) h.ctx.model = undefined;
    h.start();
    expect(h.widget).toBeDefined();
    expect(h.text()).toMatch(
      provider === undefined ? /no model/i : /not supported/i,
    );
    await vi.advanceTimersByTimeAsync(REFRESH);
    expect(h.getProviderAuth).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    h.shutdown();
  },
);

test.each(["anthropic", "openai-codex"])(
  "toggle fetches only %s and renders above the editor",
  async (provider) => {
    const h = harness(provider);
    await h.toggle();
    expect(h.setWidget).toHaveBeenCalledExactlyOnceWith(
      "pix-usage",
      expect.any(Function),
      { placement: "aboveEditor" },
    );
    await flush();
    expect(h.getProviderAuth).toHaveBeenCalledExactlyOnceWith(provider);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.text()).toContain(
      provider === "anthropic" ? " Claude  5-hour" : " Codex 󱛡 Weekly",
    );
    expect(h.text()).toContain(provider === "anthropic" ? "12%" : "93%");
    expect(h.notify).toHaveBeenCalledExactlyOnceWith(
      "Usage widget shown.",
      "info",
    );
    h.shutdown();
  },
);

test("updates countdowns locally, refreshes every five minutes, and stops when hidden", async () => {
  const h = harness();
  await h.toggle();
  await flush();
  expect(h.text()).toContain("5h");
  h.requestRender.mockClear();
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(h.text()).toContain("4h 59m");
  expect(h.requestRender).toHaveBeenCalled();
  expect(h.fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(REFRESH - MINUTE);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(h.setWidget).toHaveBeenCalledOnce();
  await h.toggle();
  expect(h.widget).toBeUndefined();
  expect(h.setWidget).toHaveBeenLastCalledWith("pix-usage", undefined);
  expect(h.notify).toHaveBeenLastCalledWith("Usage widget hidden.", "info");
  expect(vi.getTimerCount()).toBe(0);
  h.requestRender.mockClear();
  await vi.advanceTimersByTimeAsync(REFRESH * 2);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(h.requestRender).not.toHaveBeenCalled();
  await h.toggle();
  await flush();
  expect(h.fetch).toHaveBeenCalledTimes(3);
  h.shutdown();
});

test("turn_end refreshes at the one-minute boundary and skips bursts without queuing a retry", async () => {
  const h = harness();
  h.start();
  await flush();
  h.turnEnd();
  await vi.advanceTimersByTimeAsync(MINUTE - 1);
  h.turnEnd();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.fetch).toHaveBeenCalledOnce();
  h.fetch.mockResolvedValueOnce(
    Response.json({ five_hour: { utilization: 34 } }),
  );
  expect(h.turnEnd()).toBeUndefined();
  h.turnEnd();
  h.turnEnd();
  await flush();
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(h.text()).toContain("34%");
  await vi.advanceTimersByTimeAsync(MINUTE - 1);
  h.turnEnd();
  await flush();
  expect(h.fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  h.turnEnd();
  await flush();
  expect(h.fetch).toHaveBeenCalledTimes(3);
  expect(h.notify).not.toHaveBeenCalled();
  h.shutdown();
});

test("the five-minute fallback and turn_end share a cooldown", async () => {
  const h = harness();
  h.start();
  await flush();
  await vi.advanceTimersByTimeAsync(REFRESH - 1);
  h.turnEnd();
  await flush();
  expect(h.fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(REFRESH);
  expect(h.fetch).toHaveBeenCalledTimes(3);
  h.turnEnd();
  await flush();
  expect(h.fetch).toHaveBeenCalledTimes(3);
  h.shutdown();
});

test("failed turn_end attempts also start the cooldown", async () => {
  const h = harness();
  h.start();
  await flush();
  await vi.advanceTimersByTimeAsync(MINUTE);
  h.fetch.mockResolvedValueOnce(new Response(null, { status: 429 }));
  h.turnEnd();
  await flush();
  expect(h.text()).toContain("rate limited");
  await vi.advanceTimersByTimeAsync(MINUTE - 1);
  h.turnEnd();
  await flush();
  expect(h.fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  h.turnEnd();
  await flush();
  expect(h.fetch).toHaveBeenCalledTimes(3);
  expect(h.text()).toContain("12%");
  h.shutdown();
});

test("wall-clock changes do not bypass or extend the one-minute cooldown", async () => {
  const h = harness();
  h.start();
  await flush();
  vi.setSystemTime(NOW + 86_400_000);
  h.turnEnd();
  await flush();
  expect(h.fetch).toHaveBeenCalledOnce();
  vi.setSystemTime(NOW - 86_400_000);
  await vi.advanceTimersByTimeAsync(MINUTE);
  h.turnEnd();
  await flush();
  expect(h.fetch).toHaveBeenCalledTimes(2);
  h.shutdown();
});

test("manual reports bypass the widget cooldown", async () => {
  const h = harness();
  h.start();
  await flush();
  await h.command.handler("claude", h.ctx);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  h.turnEnd();
  await flush();
  expect(h.fetch).toHaveBeenCalledTimes(2);
  h.shutdown();
});

test("turn_end refreshes do not block the hook and still share requests with reports", async () => {
  const h = harness();
  h.start();
  await flush();
  let finish!: (auth: Awaited<ReturnType<ResolveAuth>>) => void;
  h.getProviderAuth.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(h.turnEnd()).toBeUndefined();
  h.turnEnd();
  expect(h.getProviderAuth).toHaveBeenCalledTimes(2);
  const report = h.command.handler("claude", h.ctx);
  expect(h.getProviderAuth).toHaveBeenCalledTimes(2);
  await h.toggle();
  finish({ source: "OAuth", auth: { apiKey: "claude-test-token" } });
  await report;
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(h.widget).toBeUndefined();
  expect(h.notify).toHaveBeenLastCalledWith(
    expect.stringContaining("12%"),
    "info",
  );
  expect(vi.getTimerCount()).toBe(0);
  h.shutdown();
});

test("turn_end respects hidden and disposed widgets", async () => {
  const h = harness();
  h.start();
  await flush();
  await h.toggle();
  await vi.advanceTimersByTimeAsync(MINUTE);
  h.turnEnd();
  await flush();
  expect(h.getProviderAuth).toHaveBeenCalledOnce();
  expect(h.widget).toBeUndefined();
  h.shutdown();
  h.turnEnd();
  await flush();
  expect(h.getProviderAuth).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["openai", "openai-codex"])(
  "turn_end follows the live provider %s if model_select has not arrived yet",
  async (provider) => {
    const h = harness();
    h.start();
    await flush();
    await vi.advanceTimersByTimeAsync(MINUTE);
    h.ctx.model = { ...h.ctx.model, provider } as NonNullable<
      ExtensionContext["model"]
    >;
    h.turnEnd();
    await flush();
    expect(h.text()).not.toContain("Claude");
    expect(h.text()).toContain(
      provider === "openai" ? "not supported" : "Codex",
    );
    expect(h.getProviderAuth.mock.calls.map(([id]) => id)).toEqual(
      provider === "openai" ? ["anthropic"] : ["anthropic", "openai-codex"],
    );
    h.shutdown();
  },
);

test("provider changes and re-showing stay immediate, with subsequent turns throttled", async () => {
  const h = harness();
  h.start();
  await flush();
  h.select("openai-codex");
  await flush();
  h.turnEnd();
  await flush();
  expect(h.fetch).toHaveBeenCalledTimes(2);
  await h.toggle();
  await h.toggle();
  await flush();
  h.turnEnd();
  await flush();
  expect(h.fetch).toHaveBeenCalledTimes(3);
  h.shutdown();
});

test("switching models within a provider does not refetch", async () => {
  const h = harness();
  await h.toggle();
  await flush();
  h.select("anthropic");
  await flush();
  expect(h.fetch).toHaveBeenCalledOnce();
  expect(h.text()).toContain("Claude");
  h.shutdown();
});

test.each(["openai", "openai-codex"])(
  "reentrant model selection follows live %s state rather than the delayed event",
  async (provider) => {
    const h = harness("openai-codex");
    await h.toggle();
    await flush();
    const oldModel = h.ctx.model;
    const original = {
      ...oldModel,
      provider: "anthropic",
    } as ModelSelectEvent["model"];
    const latest = { ...oldModel, provider } as ModelSelectEvent["model"];
    const handler = h.handlers.get("model_select");
    if (!handler) throw new Error("Missing model handler");
    const runtime = createExtensionRuntime();
    const extension = {
      path: "usage-widget-model-race-test",
      handlers: new Map([
        [
          "model_select",
          [
            async (event: ModelSelectEvent) => {
              if (event.model !== original) return;
              // Another extension switches models while Pi is awaiting this handler.
              h.ctx.model = latest;
              await runner.emit({
                type: "model_select",
                model: latest,
                previousModel: original,
                source: "set",
              });
            },
            handler,
          ],
        ],
      ]),
    } as unknown as Extension;
    const runner = new ExtensionRunner(
      [extension],
      runtime,
      "/tmp",
      SessionManager.inMemory("/tmp"),
      h.ctx.modelRegistry,
    );
    runner.bindCore(runtime, {
      getModel: () => h.ctx.model,
    } as ExtensionContextActions);
    runner.setUIContext(h.ctx.ui, "tui");
    const errors = vi.fn();
    runner.onError(errors);
    h.ctx.model = original;
    try {
      // Exercise Pi's real asynchronous dispatcher and live ExtensionContext getter.
      await runner.emit({
        type: "model_select",
        model: original,
        previousModel: oldModel,
        source: "set",
      });
      await flush();
      expect(errors).not.toHaveBeenCalled();
      expect(runner.createContext().model?.provider).toBe(provider);
      expect(h.getProviderAuth).toHaveBeenCalledExactlyOnceWith("openai-codex");
      expect(h.text()).not.toContain("Claude");
      expect(h.text()).toContain(
        provider === "openai" ? "not supported" : "Codex",
      );
      expect(vi.getTimerCount()).toBe(provider === "openai" ? 0 : 2);
      await vi.advanceTimersByTimeAsync(REFRESH);
      expect(h.getProviderAuth.mock.calls.map(([id]) => id)).toEqual(
        provider === "openai"
          ? ["openai-codex"]
          : ["openai-codex", "openai-codex"],
      );
    } finally {
      h.shutdown();
    }
  },
);

test.each(
  ["openai", "openai-codex"].flatMap((provider) =>
    ["fallback polling", "successful completion", "failed completion"].map(
      (trigger) => ({ provider, trigger }),
    ),
  ),
)(
  "$trigger follows live $provider selection while an earlier model_select handler is pending",
  async ({ provider, trigger }) => {
    const h = harness();
    let finish!: (response: Response) => void;
    if (trigger !== "fallback polling") {
      h.fetch.mockImplementationOnce(
        () =>
          new Promise((done) => {
            finish = done;
          }),
      );
    }
    const previousModel = h.ctx.model;
    const model = { ...previousModel, provider } as ModelSelectEvent["model"];
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const handlers = new Map(
      [...h.handlers].map(([name, handler]) => [name, [handler]]),
    );
    handlers.get("model_select")?.unshift(async () => {
      entered();
      await held;
    });
    const runtime = createExtensionRuntime();
    const runner = new ExtensionRunner(
      [
        {
          path: "usage-widget-delayed-model-race-test",
          handlers,
        } as unknown as Extension,
      ],
      runtime,
      "/tmp",
      SessionManager.inMemory("/tmp"),
      h.ctx.modelRegistry,
    );
    runner.bindCore(runtime, {
      getModel: () => h.ctx.model,
    } as ExtensionContextActions);
    runner.setUIContext(h.ctx.ui, "tui");
    const errors = vi.fn();
    runner.onError(errors);
    await runner.emit({ type: "session_start", reason: "startup" });
    await flush();
    expect(h.getProviderAuth).toHaveBeenCalledExactlyOnceWith("anthropic");
    h.ctx.model = model;
    const selecting = runner.emit({
      type: "model_select",
      model,
      previousModel,
      source: "set",
    });
    try {
      await started;
      if (trigger === "fallback polling") {
        await vi.advanceTimersByTimeAsync(REFRESH);
      } else {
        finish(
          trigger === "successful completion"
            ? Response.json({ five_hour: { utilization: 12 } })
            : new Response(null, { status: 429 }),
        );
        await flush();
      }
      expect(runner.createContext().model?.provider).toBe(provider);
      expect(h.getProviderAuth.mock.calls.map(([id]) => id)).toEqual(
        provider === "openai" ? ["anthropic"] : ["anthropic", "openai-codex"],
      );
      expect(h.fetch).toHaveBeenCalledTimes(provider === "openai" ? 1 : 2);
      expect(h.text()).not.toContain("Claude");
      expect(h.text()).toContain(
        provider === "openai" ? "not supported" : "Codex",
      );
      expect(vi.getTimerCount()).toBe(provider === "openai" ? 0 : 2);
      release();
      await selecting;
      await vi.advanceTimersByTimeAsync(REFRESH);
      expect(h.getProviderAuth.mock.calls.map(([id]) => id)).toEqual(
        provider === "openai"
          ? ["anthropic"]
          : ["anthropic", "openai-codex", "openai-codex"],
      );
      expect(errors).not.toHaveBeenCalled();
    } finally {
      release();
      await selecting;
      h.shutdown();
    }
  },
);

test("switching providers clears old data and discards late credential resolution", async () => {
  const h = harness();
  let finish!: (auth: Awaited<ReturnType<ResolveAuth>>) => void;
  h.getProviderAuth.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  await h.toggle();
  expect(h.text()).toContain("Claude");
  h.select("openai-codex");
  expect(h.text()).not.toContain("Claude");
  expect(h.text()).toContain("Codex");
  await flush();
  finish({ source: "OAuth", auth: { apiKey: "old-claude-token" } });
  await flush();
  expect(h.getProviderAuth.mock.calls.map(([id]) => id)).toEqual([
    "anthropic",
    "openai-codex",
  ]);
  expect(h.fetch).toHaveBeenCalledOnce();
  expect(String(h.fetch.mock.calls[0]?.[0])).toContain("chatgpt.com");
  expect(h.text()).toContain("93%");
  expect(h.text()).not.toContain("Claude");
  h.shutdown();
});

test("unsupported providers do not resolve credentials or poll", async () => {
  const h = harness("openai");
  await h.toggle();
  expect(h.text()).toMatch(/not supported|unsupported/i);
  expect(h.text()).not.toContain("0%");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(REFRESH);
  expect(h.getProviderAuth).not.toHaveBeenCalled();
  h.select("anthropic");
  await flush();
  expect(h.text()).toContain("12%");
  h.select("custom-provider");
  expect(h.text()).not.toContain("12%");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(REFRESH);
  expect(h.fetch).toHaveBeenCalledOnce();
  h.shutdown();
});

test("no selected model shows a distinct state without fetching", async () => {
  const h = harness();
  h.ctx.model = undefined;
  await h.toggle();
  expect(h.text()).toMatch(/no model/i);
  expect(h.getProviderAuth).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  h.shutdown();
});

test.each(["rpc", "json", "print"] as const)(
  "startup and toggle do not start work in %s",
  async (mode) => {
    const h = harness("anthropic", mode);
    h.start();
    expect(h.notify).not.toHaveBeenCalled();
    await h.toggle();
    h.select("anthropic");
    await vi.advanceTimersByTimeAsync(REFRESH);
    h.turnEnd();
    await flush();
    expect(h.setWidget).not.toHaveBeenCalled();
    expect(h.getProviderAuth).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    if (mode === "rpc")
      expect(h.notify).toHaveBeenCalledWith(
        "The usage widget requires terminal UI.",
        "warning",
      );
  },
);

test("a failed refresh replaces the old quota, without unsolicited notifications or fast retries", async () => {
  const h = harness();
  await h.toggle();
  await flush();
  h.fetch.mockResolvedValueOnce(new Response(null, { status: 429 }));
  await vi.advanceTimersByTimeAsync(REFRESH);
  expect(h.text()).toContain("rate limited");
  expect(h.text()).not.toContain("12%");
  expect(h.notify).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(REFRESH - MINUTE);
  expect(h.text()).toContain("12%");
  expect(h.fetch).toHaveBeenCalledTimes(3);
  h.shutdown();
});

test("missing OAuth is shown in the widget and can recover on the next refresh", async () => {
  const h = harness();
  h.getProviderAuth.mockResolvedValueOnce(undefined);
  await h.toggle();
  await flush();
  expect(h.text()).toContain("No Pi subscription login");
  expect(h.text()).not.toContain("0%");
  expect(h.fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(REFRESH);
  expect(h.text()).toContain("12%");
  h.shutdown();
});

test.each(["widget", "report"] as const)(
  "overlapping %s-first requests share work; hiding never cancels the report",
  async (first) => {
    const h = harness();
    let finish!: (auth: Awaited<ReturnType<ResolveAuth>>) => void;
    h.getProviderAuth.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    let report: Promise<void> | undefined;
    if (first === "report") report = h.command.handler("claude", h.ctx);
    await h.toggle();
    expect(h.setWidget).toHaveBeenCalledOnce();
    expect(h.text()).toContain("Loading usage");
    if (first === "widget") report = h.command.handler("claude", h.ctx);
    expect(h.getProviderAuth).toHaveBeenCalledOnce();
    await h.toggle();
    finish({ source: "OAuth", auth: { apiKey: "claude-test-token" } });
    await report;
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.widget).toBeUndefined();
    expect(h.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("12%"),
      "info",
    );
    expect(vi.getTimerCount()).toBe(0);
    h.shutdown();
  },
);

test("hiding the last consumer aborts the HTTP request and late work cannot resurrect the widget", async () => {
  const h = harness();
  let signal: AbortSignal | null | undefined;
  h.fetch.mockImplementationOnce(async (_url, init) => {
    signal = init?.signal;
    return new Response(new ReadableStream());
  });
  await h.toggle();
  await flush();
  expect(signal?.aborted).toBe(false);
  await h.toggle();
  await flush();
  expect(signal?.aborted).toBe(true);
  expect(h.widget).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  expect(h.notify).toHaveBeenCalledTimes(2);
});

test("shutdown cancels shared HTTP work, suppresses late output, and resets visibility", async () => {
  const h = harness();
  let signal: AbortSignal | null | undefined;
  h.fetch.mockImplementationOnce(async (_url, init) => {
    signal = init?.signal;
    return new Response(new ReadableStream());
  });
  await h.toggle();
  await flush();
  const report = h.command.handler("claude", h.ctx);
  const oldWidget = h.widget;
  h.shutdown();
  h.shutdown();
  await report;
  expect(signal?.aborted).toBe(true);
  expect(h.widget).toBeUndefined();
  expect(oldWidget?.render(80)).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  expect(h.notify).toHaveBeenCalledTimes(1);
  h.select("anthropic");
  await vi.advanceTimersByTimeAsync(REFRESH);
  expect(h.fetch).toHaveBeenCalledOnce();
  await h.toggle();
  await flush();
  expect(h.text()).toContain("12%");
  expect(h.fetch).toHaveBeenCalledTimes(2);
  h.shutdown();
});

test("a timed-out credential lookup renders an error and the next scheduled refresh recovers", async () => {
  const h = harness();
  const timeout = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
  h.getProviderAuth.mockReturnValueOnce(new Promise(() => {}));
  await h.toggle();
  timeout.abort();
  await flush();
  expect(h.text()).toContain("Usage request cancelled or timed out.");
  expect(h.fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(REFRESH);
  expect(h.text()).toContain("12%");
  expect(h.getProviderAuth).toHaveBeenCalledTimes(2);
  h.shutdown();
});

test("provider switches leave a shared report intact while moving the widget to the new provider", async () => {
  const h = harness();
  let finish!: (auth: Awaited<ReturnType<ResolveAuth>>) => void;
  h.getProviderAuth.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  await h.toggle();
  const report = h.command.handler("claude", h.ctx);
  h.select("openai-codex");
  await flush();
  expect(h.text()).toContain("Codex");
  finish({ source: "OAuth", auth: { apiKey: "claude-test-token" } });
  await report;
  expect(h.getProviderAuth).toHaveBeenCalledTimes(2);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(h.notify).toHaveBeenLastCalledWith(
    expect.stringContaining("12%"),
    "info",
  );
  expect(h.text()).toContain("93%");
  expect(h.text()).not.toContain("Claude");
  h.shutdown();
});

test("idle theme changes and resizing use the live theme without replacing or refetching the widget", async () => {
  const h = harness();
  await h.toggle();
  await flush();
  const first = h.widget?.render(80);
  Object.defineProperty(h.ctx.ui, "theme", {
    configurable: true,
    value: {
      fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[39m`,
      getFgAnsi: () => "\u001b[36m",
    },
  });
  h.widget?.invalidate();
  const second = h.widget?.render(80);
  expect(second).not.toEqual(first);
  expect(second?.map(stripVTControlCharacters)).toEqual(first);
  expect(h.widget?.render(0)).toEqual([]);
  expect(h.widget?.render(20)).toHaveLength(2);
  expect(h.fetch).toHaveBeenCalledOnce();
  expect(h.setWidget).toHaveBeenCalledOnce();
  h.shutdown();
});

test("Pi disposing the component releases resources even before session shutdown", async () => {
  const h = harness();
  h.getProviderAuth.mockReturnValueOnce(new Promise(() => {}));
  await h.toggle();
  const component = h.widget;
  component?.dispose?.();
  component?.dispose?.();
  await flush();
  expect(vi.getTimerCount()).toBe(0);
  expect(component?.render(80)).toEqual([]);
  await vi.advanceTimersByTimeAsync(REFRESH);
  expect(h.fetch).not.toHaveBeenCalled();
  h.shutdown();
});
