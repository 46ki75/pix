import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverAndLoadExtensions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import themeInspector from "./index.ts";
import { TOKENS } from "./tokens.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function testTheme(
  name: string,
  mode: ReturnType<Theme["getColorMode"]> = "truecolor",
): Theme {
  const foreground = Object.fromEntries(
    TOKENS.filter((token) => token.kind === "foreground").map((token) => [
      token.name,
      "#112233",
    ]),
  ) as ConstructorParameters<typeof Theme>[0];
  const background = Object.fromEntries(
    TOKENS.filter((token) => token.kind === "background").map((token) => [
      token.name,
      "",
    ]),
  ) as ConstructorParameters<typeof Theme>[1];
  return new Theme(foreground, background, mode, { name });
}

function harness(mode: ExtensionCommandContext["mode"] = "tui") {
  const commands = new Map<string, Command>();
  const notify = vi.fn<ExtensionUIContext["notify"]>();
  const getTheme = vi.fn(() => {
    if (mode !== "tui") throw new Error("No terminal theme available");
    return testTheme("first-theme");
  });
  // Registering tools, event handlers, or sending messages would fail this harness.
  const api = {
    registerCommand: (name: string, command: Command) =>
      commands.set(name, command),
  } as unknown as ExtensionAPI;
  themeInspector(api);
  const command = commands.get("theme-colors");
  if (!command) throw new Error("Missing command");
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      notify,
      get theme() {
        return getTheme();
      },
    },
  } as unknown as ExtensionCommandContext;
  return { command, commands, ctx, notify, getTheme };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("Pi loads the package with only the command and no startup work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pix-theme-inspector-"));
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
    expect([...(extension?.commands.keys() ?? [])]).toEqual(["theme-colors"]);
    expect(extension?.tools.size).toBe(0);
    expect(extension?.handlers.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prints one report without model calls or session entries", async () => {
  const { command, commands, ctx, notify, getTheme } = harness();
  expect(commands.size).toBe(1);
  await command.handler("", ctx);
  expect(getTheme).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('Theme: "first-theme" | truecolor | 56 tokens'),
    "info",
  );
  expect(notify.mock.calls[0]?.[0]).toContain("toolErrorBg");
});

test("reads the new active theme on each invocation", async () => {
  const { command, ctx, notify, getTheme } = harness();
  await command.handler("", ctx);
  getTheme.mockReturnValue(testTheme("second-theme", "256color"));
  await command.handler("  ", ctx);
  expect(getTheme).toHaveBeenCalledTimes(2);
  expect(notify.mock.calls[0]?.[0]).toContain(
    'Theme: "first-theme" | truecolor',
  );
  expect(notify.mock.calls[1]?.[0]).toContain(
    'Theme: "second-theme" | 256color',
  );
});

test.each(["rpc", "json", "print"] as const)(
  "does not access terminal themes in %s mode",
  async (mode) => {
    const { command, ctx, notify, getTheme } = harness(mode);
    await command.handler("", ctx);
    expect(getTheme).not.toHaveBeenCalled();
    if (mode === "rpc") {
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        "/theme-colors requires Pi's terminal UI.",
        "warning",
      );
    } else {
      expect(notify).not.toHaveBeenCalled();
    }
  },
);

test("rejects unsupported arguments without reading the theme", async () => {
  const { command, ctx, notify, getTheme } = harness();
  await command.handler("accent", ctx);
  expect(getTheme).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    "Usage: /theme-colors",
    "warning",
  );
});
