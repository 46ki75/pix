import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  const getProviderAuth = vi.fn<ResolveAuth>().mockResolvedValue({
    source: "OAuth",
    auth: { apiKey: "claude-test-token" },
  });
  const api = {
    registerCommand: (name: string, command: Command) =>
      commands.set(name, command),
    on: (name: string, handler: () => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  } as unknown as ExtensionAPI;
  subscriptionUsage(api);
  const command = commands.get("usage");
  if (!command) throw new Error("Missing command");
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    modelRegistry: { getProviderAuth },
    ui: { notify, theme: { fg, getFgAnsi } },
  } as unknown as ExtensionCommandContext;
  return {
    command,
    ctx,
    notify,
    fg,
    getFgAnsi,
    getProviderAuth,
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
    expect(extension?.handlers.has("session_start")).toBe(false);
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
    const muted = "\u001b[38;5;7m";
    const text = "\u001b[38;5;15m";
    const border = "\u001b[38;5;6m";
    const ambient = warning ? "\u001b[38;5;11m" : dim;
    const width = warning ? 87 : 30;
    const header = `── 󱘖 Usage ${"─".repeat(width - 11)}`;
    const footer = "─".repeat(width);
    fg.mockImplementation(
      (color, span) =>
        `${color === "muted" ? muted : color === "border" ? border : text}${span}\u001b[39m`,
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
    expect(notify.mock.calls[0]?.[1]).toBe(warning ? "warning" : "info");
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
        ["muted", ""],
        ["text", ""],
        ["text", "󰓅"],
        ["text", ""],
        ["text", "󱛡"],
        ["text", "󰓅"],
        ["text", ""],
        ...(warning ? [["muted", ""]] : []),
        ["border", header],
        ["border", footer],
      ]);
      expect(getFgAnsi).toHaveBeenCalledWith(warning ? "warning" : "dim");
      expect(
        message?.startsWith(`${border}${header}\u001b[39m${ambient}\n\n`),
      ).toBe(true);
      expect(
        message?.endsWith(`\n\n${border}${footer}\u001b[39m${ambient}`),
      ).toBe(true);
      expect(message).toContain(`${muted}\u001b[39m${ambient} Claude`);
      expect(message).toContain(`${text}\u001b[39m${ambient} 5-hour`);
      expect(message).toContain(`${text}󱛡\u001b[39m${ambient} Weekly`);
      expect(message).toContain(`${text}󰓅\u001b[39m${ambient}  10%`);
      expect(message).toContain(`${text}\u001b[39m${ambient} -d --h --m`);
      if (warning)
        expect(message).toContain(`${muted}\u001b[39m${ambient} Codex`);
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
    const ambient = warning ? "\u001b[38;5;11m" : "\u001b[38;5;8m";
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
    expect(notify.mock.calls[0]?.[1]).toBe(warning ? "warning" : "info");
    if (mode === "rpc") {
      expect(fg).not.toHaveBeenCalled();
      expect(getFgAnsi).not.toHaveBeenCalled();
      expect(message).not.toContain("\u001b");
      expect(message).toContain("󰓅  51%  -d --h --m");
      expect(message).toContain("󰓅  76%  -d --h --m");
    } else {
      expect(fg).toHaveBeenCalledWith("warning", " 51%");
      expect(fg).toHaveBeenCalledWith("error", " 76%");
      expect(getFgAnsi).toHaveBeenCalledWith(warning ? "warning" : "dim");
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
    "Usage: /usage [claude|codex|all]",
    "warning",
  );
  expect(getProviderAuth).not.toHaveBeenCalled();
  expect(command.getArgumentCompletions?.("c")).toEqual([
    { value: "claude", label: "claude" },
    { value: "codex", label: "codex" },
  ]);
  expect(command.getArgumentCompletions?.("bad")).toBeNull();
});

test.each(["", "all"])(
  "%j checks both providers independently",
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
      " Codex: No Pi subscription login",
    );
    expect(notify.mock.calls[0]?.[1]).toBe("warning");
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
    `── 󱘖 Usage ${"─".repeat(36)}\n\n Claude: Usage request cancelled or timed out.\n\n${"─".repeat(47)}`,
    "warning",
  );
  getProviderAuth.mockResolvedValue(undefined);
  await command.handler("claude", ctx);
  expect(getProviderAuth).toHaveBeenCalledTimes(2);
  expect(notify).toHaveBeenLastCalledWith(
    expect.stringContaining("No Pi subscription login"),
    "warning",
  );
});
