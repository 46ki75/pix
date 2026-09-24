import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  discoverAndLoadExtensions,
  type ExtensionContext,
  type ExtensionUIContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";

test.each(["tui", "rpc", "json", "print"] as const)(
  "loads the package and handles session replacement in %s mode",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "pix-statusline-"));
    try {
      const loaded = await discoverAndLoadExtensions(
        [fileURLToPath(new URL("../", import.meta.url))],
        directory,
        join(directory, "agent"),
      );
      expect(loaded.errors).toEqual([]);
      expect(loaded.extensions).toHaveLength(1);
      const extension = loaded.extensions[0];
      if (!extension) throw new Error("Extension did not load");
      expect(extension.tools.size).toBe(0);
      const setFooter = vi.fn<ExtensionUIContext["setFooter"]>();
      const ctx = {
        mode,
        hasUI: mode === "tui" || mode === "rpc",
        cwd: directory,
        ui: { setFooter },
        sessionManager: SessionManager.inMemory(directory),
        getContextUsage: () => undefined,
      } as unknown as ExtensionContext;
      const emit = async (event: string, reason: string) => {
        for (const handler of extension.handlers.get(event) ?? []) {
          await handler({ type: event, reason }, ctx);
        }
      };
      await emit("session_start", "startup");
      if (mode === "tui") {
        const factory = setFooter.mock.calls[0]?.[0];
        if (!factory) throw new Error("Missing footer factory");
        const unsubscribe = vi.fn();
        // Pi owns the concrete TUI and Theme; the footer only needs these methods.
        const footer = factory(
          { requestRender: vi.fn() } as unknown as Parameters<
            typeof factory
          >[0],
          { fg: (_color: string, text: string) => text } as Parameters<
            typeof factory
          >[1],
          {
            getGitBranch: () => null,
            getExtensionStatuses: () => new Map(),
            getAvailableProviderCount: () => 0,
            onBranchChange: () => unsubscribe,
          },
        );
        const lines = footer.render(1_000);
        expect(lines).toHaveLength(3);
        expect(lines[1]).toBe("");
        const location = stripVTControlCharacters(lines[2] ?? "");
        expect(location.replace(/ +$/, " ")).toBe(`  ${directory}  `);
        expect(visibleWidth(location)).toBe(1_000);
        expect(footer.render(80).join("\n")).toContain("no-model");
        footer.dispose?.();
        expect(unsubscribe).toHaveBeenCalledOnce();
      } else {
        expect(setFooter).not.toHaveBeenCalled();
      }
      for (const reason of ["new", "resume", "fork", "reload"]) {
        await emit("session_shutdown", reason);
        if (mode === "tui")
          expect(setFooter).toHaveBeenLastCalledWith(undefined);
        await emit("session_start", reason);
        if (mode === "tui")
          expect(setFooter).toHaveBeenLastCalledWith(expect.any(Function));
      }
      await emit("session_shutdown", "quit");
      if (mode !== "tui") expect(setFooter).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
