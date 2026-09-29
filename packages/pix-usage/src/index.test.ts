import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  discoverAndLoadExtensions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import subscriptionUsage from "./index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type ResolveAuth = ExtensionCommandContext["modelRegistry"]["getProviderAuth"];

const originalColumns = Object.getOwnPropertyDescriptor(
  process.stdout,
  "columns",
);

function setTerminalColumns(columns: number | undefined): void {
  Object.defineProperty(process.stdout, "columns", {
    value: columns,
    configurable: true,
    writable: true,
  });
}

function harness(mode: ExtensionCommandContext["mode"] = "tui") {
  const commands = new Map<string, Command>();
  const handlers = new Map<string, () => void>();
  const notify = vi.fn<ExtensionUIContext["notify"]>();
  const fg = vi.fn<ExtensionUIContext["theme"]["fg"]>((_color, text) => text);
  const getFgAnsi = vi.fn<ExtensionUIContext["theme"]["getFgAnsi"]>(() => "");
  const getProviderAuth = vi
    .fn<ResolveAuth>()
    .mockImplementation(async (provider) => ({
      source: "OAuth",
      auth: {
        apiKey:
          provider === "meta"
            ? "LLM|muse-inference-key"
            : provider === "opencode-go"
              ? "opencode-test-key"
              : "claude-test-token",
      },
    }));
  const getProviderAuthStatus = vi.fn().mockImplementation((provider) =>
    provider === "opencode-go"
      ? {
          configured: true,
          source: "environment",
          label: "OPENCODE_API_KEY",
        }
      : { configured: false },
  );
  const getProvider = vi.fn().mockReturnValue({
    getModels: () => [{ baseUrl: "https://opencode.ai/zen/go/v1" }],
  });
  const getRegisteredProviderIds = vi.fn().mockReturnValue([]);
  const credentialExpires = Date.now() + 60_000;
  const readCredential = vi.fn().mockImplementation((provider) =>
    provider === "meta"
      ? {
          type: "oauth" as const,
          refresh: "dca:muse-device-token",
          access: "LLM|muse-inference-key",
          expires: credentialExpires,
        }
      : undefined,
  );
  const api = {
    registerCommand: (name: string, command: Command) =>
      commands.set(name, command),
    on: (name: string, handler: () => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  } as unknown as ExtensionAPI;
  subscriptionUsage(api, { readCredential });
  const command = commands.get("usage");
  if (!command) throw new Error("Missing command");
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    modelRegistry: {
      getProviderAuth,
      getProviderAuthStatus,
      getProvider,
      getRegisteredProviderIds,
    },
    ui: { notify, theme: { fg, getFgAnsi } },
  } as unknown as ExtensionCommandContext;
  return {
    command,
    ctx,
    notify,
    fg,
    getFgAnsi,
    getProviderAuth,
    getProviderAuthStatus,
    readCredential,
    shutdown: () => handlers.get("session_shutdown")?.(),
  };
}

afterEach(() => {
  if (originalColumns)
    Object.defineProperty(process.stdout, "columns", originalColumns);
  else Reflect.deleteProperty(process.stdout, "columns");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("Pi loads the package without starting network or registering tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pix-usage-"));
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  try {
    const loaded = await discoverAndLoadExtensions(
      [fileURLToPath(new URL("../", import.meta.url))],
      directory,
      join(directory, "agent"),
    );
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const extension = loaded.extensions[0];
    expect(extension?.commands.has("usage")).toBe(true);
    expect(extension?.tools.size).toBe(0);
    expect(extension?.handlers.has("session_start")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["tui", "rpc"] as const)(
  "reports quota through native notifications in %s",
  async (mode) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-25T00:00:00Z"));
    const { command, ctx, notify, getProviderAuth } = harness(mode);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        five_hour: { utilization: 12.34, resets_at: "2026-09-25T05:00:00Z" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await command.handler("claude", ctx);
    expect(getProviderAuth).toHaveBeenCalledExactlyOnceWith("anthropic");
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        " 5-hour 󰓅 12.3%          5h 2026-09-25 05:00:00 (UTC)",
      ),
      "info",
    );
    expect(notify.mock.calls[0]?.[0]).not.toContain("claude-test-token");
  },
);

test("reports Meta Muse quota with Pi's device OAuth credential", async () => {
  const {
    command,
    ctx,
    notify,
    getProviderAuth,
    getProviderAuthStatus,
    readCredential,
  } = harness();
  getProviderAuthStatus.mockReturnValue({ configured: true, source: "stored" });
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      is_subs_active: true,
      subs_usage: {
        window: { used_percent: 18, window_duration_mins: 300 },
        weekly: { used_percent: 27 },
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);

  await command.handler("muse", ctx);
  expect(getProviderAuth).toHaveBeenCalledExactlyOnceWith("meta");
  expect(getProviderAuthStatus).toHaveBeenCalledExactlyOnceWith("meta");
  expect(readCredential).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    headers: expect.objectContaining({
      Authorization: "Bearer dca:muse-device-token",
    }),
  });
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("󰛤 Muse\n\n   5-hour 󰓅  18%"),
    "info",
  );
});

test("reports OpenCode Go quota with its saved API key", async () => {
  const {
    command,
    ctx,
    notify,
    getProviderAuth,
    getProviderAuthStatus,
    readCredential,
  } = harness();
  getProviderAuthStatus.mockReturnValue({
    configured: true,
    source: "stored",
  });
  readCredential.mockReturnValue({
    type: "api_key",
    key: "opencode-test-key",
  });
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      usage: {
        rolling: {
          status: "ok",
          percent: 18,
          resetsAt: "2026-09-29T18:00:00Z",
        },
        weekly: {
          status: "ok",
          percent: 27,
          resetsAt: "2026-10-05T00:00:00Z",
        },
        monthly: {
          status: "ok",
          percent: 36,
          resetsAt: "2026-10-29T00:00:00Z",
        },
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);

  await command.handler("opencode", ctx);
  expect(getProviderAuth).not.toHaveBeenCalled();
  expect(readCredential).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
    Authorization: "Bearer opencode-test-key",
  });
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("󰨔 OpenCode Go\n\n   5-hour  󰓅  18%"),
    "info",
  );
  expect(notify.mock.calls[0]?.[0]).toContain("󰸗 Monthly 󰓅  36%");
});

test.each(
  (["tui", "rpc"] as const).flatMap((mode) =>
    [24, 80, 120].flatMap((columns) =>
      [false, true].map((warning) => ({ mode, columns, warning })),
    ),
  ),
)(
  "sizes dividers to content in $mode regardless of $columns terminal columns (warning: $warning)",
  async ({ mode, columns, warning }) => {
    setTerminalColumns(columns);
    const { command, ctx, notify, getProviderAuth } = harness(mode);
    if (warning) getProviderAuth.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json({ five_hour: { utilization: 0 } })),
    );
    await command.handler("claude", ctx);
    const lines = (notify.mock.calls[0]?.[0] ?? "").split("\n");
    const width = Math.max(...lines.slice(2, -2).map(visibleWidth));
    expect(lines[0]).toBe(`── 󱘖 Usage ${"─".repeat(width - 11)}`);
    expect(lines.at(-1)).toBe("─".repeat(width));
  },
);

test.each([
  { mode: "tui", warning: false },
  { mode: "tui", warning: true },
  { mode: "rpc", warning: false },
  { mode: "rpc", warning: true },
] as const)(
  "themes dividers and preserves icon colors in $mode (warning: $warning)",
  async ({ mode, warning }) => {
    const { command, ctx, notify, fg, getFgAnsi, getProviderAuth } =
      harness(mode);
    const dim = "\u001b[38;5;8m";
    const accent = "\u001b[38;5;14m";
    const text = "\u001b[38;5;15m";
    const border = "\u001b[38;5;6m";
    const ambient = dim;
    const openCodeWarning =
      "No Pi OpenCode Go API key; use /login opencode-go.";
    const width = warning
      ? Math.max(80, visibleWidth(`  ${openCodeWarning}`))
      : 30;
    const header = `── 󱘖 Usage ${"─".repeat(width - 11)}`;
    const footer = "─".repeat(width);
    fg.mockImplementation(
      (color, span) =>
        `${color === "accent" ? accent : color === "border" ? border : text}${span}\u001b[39m`,
    );
    getFgAnsi.mockReturnValue(ambient);
    getProviderAuth.mockImplementation(async (provider) =>
      provider === "anthropic"
        ? { source: "OAuth", auth: { apiKey: "claude-test-token" } }
        : undefined,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 20 },
        }),
      ),
    );

    await command.handler(warning ? "all" : "claude", ctx);
    const message = notify.mock.calls[0]?.[0];
    expect(notify.mock.calls[0]?.[1]).toBe("info");
    if (mode === "rpc") {
      expect(fg).not.toHaveBeenCalled();
      expect(getFgAnsi).not.toHaveBeenCalled();
      expect(message).not.toContain("\u001b");
      expect(message).toContain(" Claude");
      expect(message).toContain(" 5-hour");
      expect(message).toContain("󱛡 Weekly");
      expect(message).toContain("󰓅  10%  -d --h --m");
      expect(message?.startsWith(`${header}\n\n`)).toBe(true);
      expect(message?.endsWith(`\n\n${footer}`)).toBe(true);
    } else {
      expect(fg.mock.calls).toEqual([
        ["accent", ""],
        ["text", ""],
        ["text", "󰓅"],
        ["text", ""],
        ["text", "󱛡"],
        ["text", "󰓅"],
        ["text", ""],
        ...(warning
          ? [
              ["accent", ""],
              [
                "warning",
                "No Pi subscription login; use /login openai-codex with OAuth (not an API key).",
              ],
              ["accent", "󰛤"],
              [
                "warning",
                "No Pi subscription login; use /login meta with OAuth (not an API key).",
              ],
              ["accent", "󰨔"],
              ["warning", openCodeWarning],
            ]
          : []),
        ["border", header],
        ["border", footer],
      ]);
      expect(getFgAnsi).toHaveBeenCalledWith("dim");
      expect(
        message?.startsWith(`${border}${header}\u001b[39m${ambient}\n\n`),
      ).toBe(true);
      expect(
        message?.endsWith(`\n\n${border}${footer}\u001b[39m${ambient}`),
      ).toBe(true);
      expect(message).toContain(`${accent}\u001b[39m${ambient} Claude`);
      expect(message).toContain(`${text}\u001b[39m${ambient} 5-hour`);
      expect(message).toContain(`${text}󱛡\u001b[39m${ambient} Weekly`);
      expect(message).toContain(`${text}󰓅\u001b[39m${ambient}  10%`);
      expect(message).toContain(`${text}\u001b[39m${ambient} -d --h --m`);
      if (warning)
        expect(message).toContain(`${accent}\u001b[39m${ambient} Codex`);
    }
  },
);

test.each([
  { mode: "tui", warning: false },
  { mode: "tui", warning: true },
  { mode: "rpc", warning: false },
  { mode: "rpc", warning: true },
] as const)(
  "themes usage percentages in $mode (warning: $warning)",
  async ({ mode, warning }) => {
    const { command, ctx, notify, fg, getFgAnsi, getProviderAuth } =
      harness(mode);
    const ambient = "\u001b[38;5;8m";
    fg.mockImplementation(
      (color, text) =>
        `\u001b[${color === "warning" ? 33 : color === "error" ? 31 : 37}m${text}\u001b[39m`,
    );
    getFgAnsi.mockReturnValue(ambient);
    getProviderAuth.mockImplementation(async (provider) =>
      provider === "anthropic"
        ? { source: "OAuth", auth: { apiKey: "claude-test-token" } }
        : undefined,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json({
          five_hour: { utilization: 51 },
          seven_day: { utilization: 76 },
        }),
      ),
    );

    await command.handler(warning ? "all" : "claude", ctx);
    const message = notify.mock.calls[0]?.[0];
    expect(notify.mock.calls[0]?.[1]).toBe("info");
    if (mode === "rpc") {
      expect(fg).not.toHaveBeenCalled();
      expect(getFgAnsi).not.toHaveBeenCalled();
      expect(message).not.toContain("\u001b");
      expect(message).toContain("󰓅  51%  -d --h --m");
      expect(message).toContain("󰓅  76%  -d --h --m");
    } else {
      expect(fg).toHaveBeenCalledWith("warning", " 51%");
      expect(fg).toHaveBeenCalledWith("error", " 76%");
      expect(getFgAnsi).toHaveBeenCalledWith("dim");
      expect(message).toContain(`\u001b[33m 51%\u001b[39m${ambient} `);
      expect(message).toContain(`\u001b[31m 76%\u001b[39m${ambient} `);
    }
  },
);

test.each(["json", "print"] as const)(
  "does not read credentials or fetch in %s",
  async (mode) => {
    const { command, ctx, getProviderAuth } = harness(mode);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await command.handler("", ctx);
    expect(getProviderAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

test("validates arguments and completes provider names", async () => {
  const { command, ctx, getProviderAuth, notify } = harness();
  await command.handler("claude codex", ctx);
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    "Usage: /usage [claude|codex|muse|opencode|all|toggle]",
    "warning",
  );
  expect(getProviderAuth).not.toHaveBeenCalled();
  expect(command.getArgumentCompletions?.("c")).toEqual([
    { value: "claude", label: "claude" },
    { value: "codex", label: "codex" },
  ]);
  expect(command.getArgumentCompletions?.("m")).toEqual([
    { value: "muse", label: "muse" },
  ]);
  expect(command.getArgumentCompletions?.("o")).toEqual([
    { value: "opencode", label: "opencode" },
  ]);
  expect(command.getArgumentCompletions?.("bad")).toBeNull();
});

test.each(["", "all"])(
  "%j checks all providers independently",
  async (argument) => {
    const { command, ctx, getProviderAuth, notify } = harness();
    getProviderAuth.mockImplementation(async (provider) =>
      provider === "anthropic"
        ? { source: "OAuth", auth: { apiKey: "claude-test-token" } }
        : undefined,
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json({ seven_day: { utilization: 75 } })),
    );
    await command.handler(argument, ctx);
    expect(getProviderAuth.mock.calls).toEqual([
      ["anthropic"],
      ["openai-codex"],
    ]);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]?.[0]).toContain("󱛡 Weekly 󰓅  75%  -d --h --m");
    expect(notify.mock.calls[0]?.[0]).toContain(
      " Codex\n\n  No Pi subscription login",
    );
    expect(notify.mock.calls[0]?.[0]).toContain(
      "󰛤 Muse\n\n  No Pi subscription login",
    );
    expect(notify.mock.calls[0]?.[0]).toContain(
      "󰨔 OpenCode Go\n\n  No Pi OpenCode Go API key; use /login opencode-go.",
    );
    expect(notify.mock.calls[0]?.[1]).toBe("info");
  },
);

test.each(
  (["tui", "rpc"] as const).flatMap((mode) =>
    (["missing login", "expired login", "refresh failure"] as const).flatMap(
      (failure) => [false, true].map((mixed) => ({ mode, failure, mixed })),
    ),
  ),
)(
  "keeps the report neutral in $mode with $failure (mixed results: $mixed)",
  async ({ mode, failure, mixed }) => {
    const { command, ctx, notify, fg, getFgAnsi, getProviderAuth } =
      harness(mode);
    const dim = "\u001b[38;5;8m";
    fg.mockImplementation(
      (color, text) =>
        `\u001b[${color === "warning" ? 33 : color === "error" ? 31 : 37}m${text}\u001b[39m`,
    );
    getFgAnsi.mockReturnValue(dim);
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
      }),
    ).toString("base64url");
    getProviderAuth.mockImplementation(async (provider) => {
      if (provider === "openai-codex")
        return { source: "OAuth", auth: { apiKey: `header.${payload}.sig` } };
      if (failure === "missing login") return undefined;
      if (failure === "refresh failure") throw new Error("private details");
      return { source: "OAuth", auth: { apiKey: "expired-token" } };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) =>
        String(url).includes("anthropic.com")
          ? new Response(null, { status: 401 })
          : Response.json({
              rate_limit: {
                primary_window: {
                  used_percent: 90,
                  limit_window_seconds: 604800,
                },
              },
            }),
      ),
    );

    await command.handler(mixed ? "all" : "claude", ctx);
    expect(notify).toHaveBeenCalledExactlyOnceWith(expect.any(String), "info");
    const message = notify.mock.calls[0]?.[0] ?? "";
    const plain = stripVTControlCharacters(message);
    expect(plain).toMatch(/ Claude\n\n {2}.+/);
    expect(plain).not.toContain("Warning:");
    expect(plain).not.toContain("private details");
    const lines = plain.split("\n");
    expect(visibleWidth(lines[0] ?? "")).toBe(visibleWidth(lines.at(-1) ?? ""));
    if (mixed) expect(plain).toContain(" Codex\n\n  󱛡 Weekly 󰓅  90% ");
    if (mode === "tui") {
      expect(fg).toHaveBeenCalledWith(
        failure === "missing login" ? "warning" : "error",
        expect.stringMatching(
          /No Pi subscription login|Usage access denied|Could not resolve Pi credentials/,
        ),
      );
      expect(getFgAnsi.mock.calls.every(([color]) => color === "dim")).toBe(
        true,
      );
      if (mixed) expect(message).toContain(`\u001b[31m 90%\u001b[39m${dim} `);
    } else {
      expect(message).toBe(plain);
      expect(fg).not.toHaveBeenCalled();
      expect(getFgAnsi).not.toHaveBeenCalled();
    }
  },
);

test("does not duplicate requests while an auth lookup is in flight", async () => {
  const { command, ctx, getProviderAuth, notify, shutdown } = harness();
  getProviderAuth.mockReturnValue(new Promise(() => {}));
  const first = command.handler("claude", ctx);
  await command.handler("claude", ctx);
  expect(getProviderAuth).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    "A subscription usage check is already running.",
    "info",
  );
  shutdown();
  await first;
});

test("shutdown cancels a stalled body and suppresses stale UI output", async () => {
  const { command, ctx, notify, shutdown } = harness();
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  let requestSignal: AbortSignal | null | undefined;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (_url, init) => {
      requestSignal = init?.signal;
      requested();
      return new Response(new ReadableStream());
    });
  vi.stubGlobal("fetch", fetch);
  const pending = command.handler("claude", ctx);
  await started;
  shutdown();
  shutdown();
  await pending;
  expect(requestSignal?.aborted).toBe(true);
  expect(notify).not.toHaveBeenCalled();
});

test("late auth completion cannot affect a replacement session's check", async () => {
  const { command, ctx, notify, shutdown, getProviderAuth } = harness();
  let finish!: (value: Awaited<ReturnType<ResolveAuth>>) => void;
  getProviderAuth.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ five_hour: { utilization: 10 } }));
  vi.stubGlobal("fetch", fetch);
  const old = command.handler("claude", ctx);
  shutdown();
  const current = command.handler("claude", ctx);
  finish({ source: "OAuth", auth: { apiKey: "stale-token" } });
  await Promise.all([old, current]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
    Authorization: "Bearer claude-test-token",
  });
  expect(notify).toHaveBeenCalledOnce();
});

test("the command timeout bounds auth lookup and releases the in-flight guard", async () => {
  const { command, ctx, notify, getProviderAuth } = harness();
  getProviderAuth.mockReturnValue(new Promise(() => {}));
  const timeout = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
  const pending = command.handler("claude", ctx);
  timeout.abort();
  await pending;
  expect(notify).toHaveBeenLastCalledWith(
    `── 󱘖 Usage ${"─".repeat(28)}\n\n Claude\n\n  Usage request cancelled or timed out.\n\n${"─".repeat(39)}`,
    "info",
  );
  getProviderAuth.mockResolvedValue(undefined);
  await command.handler("claude", ctx);
  expect(getProviderAuth).toHaveBeenCalledTimes(2);
  expect(notify).toHaveBeenLastCalledWith(
    expect.stringContaining("No Pi subscription login"),
    "info",
  );
});
