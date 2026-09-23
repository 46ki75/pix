import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverAndLoadExtensions,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import type { Task } from "./registry.ts";

afterEach(() => vi.unstubAllEnvs());

test.each(["print", "json", "rpc", "tui"] as const)(
  "loads and manages tasks in %s mode without model requests",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "pix-bg-load-"));
    const sessionId = `pix-bg-test-${directory.split("/").pop()}`;
    let outputDir: string | undefined;
    const ctx = {
      mode,
      hasUI: mode === "rpc" || mode === "tui",
      cwd: directory,
      sessionManager: { getSessionId: () => sessionId },
      ui: { setStatus: vi.fn() },
    } as unknown as ExtensionContext;
    const loaded = await discoverAndLoadExtensions(
      [fileURLToPath(new URL("../", import.meta.url))],
      directory,
      join(directory, "agent"),
    );
    expect(loaded.errors).toEqual([]);
    const extension = loaded.extensions[0];
    if (!extension) throw new Error("Extension did not load");
    const emit = async (event: string, reason: string) => {
      for (const handler of extension.handlers.get(event) ?? [])
        await handler({ type: event, reason }, ctx);
    };
    const tool = (name: string) => {
      const definition = extension.tools.get(name)?.definition;
      if (!definition) throw new Error(`Missing tool ${name}`);
      return async (params: Record<string, unknown>) => {
        const result = await definition.execute(
          "call",
          params,
          undefined,
          undefined,
          ctx,
        );
        return {
          ...result,
          details: result.details as { task: Task; tasks: Task[] },
        };
      };
    };
    const send = vi.fn();
    loaded.runtime.sendMessage = send;
    vi.stubEnv("PIX_BG_MAX_OUTPUT_BYTES", "100000");
    try {
      expect([...extension.tools.keys()]).toEqual([
        "bg_run",
        "bg_status",
        "bg_kill",
      ]);
      expect(extension.shortcuts.size).toBe(0);
      await expect(tool("bg_status")({})).rejects.toThrow("not started");
      await emit("session_start", "startup");
      const result = await tool("bg_run")({
        command: "sleep 30",
        name: "test sleeper",
      });
      const task = result.details.task as Task;
      outputDir = dirname(task.outputPath);
      // A private shared /tmp/pi-bg parent would exclude every other OS user.
      expect(dirname(outputDir)).toBe(
        join(tmpdir(), `pi-bg-${userInfo().uid}`),
      );
      expect((await stat(dirname(outputDir))).mode & 0o777).toBe(0o700);
      expect(task.pid).toBeGreaterThan(0);
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining(task.outputPath),
      });
      const stopped = await tool("bg_kill")({ id: task.id });
      expect(stopped.details.task.outcome).toEqual({
        kind: "killed",
        by: "agent",
      });
      expect(send).not.toHaveBeenCalled();
      const natural = (await tool("bg_run")({ command: "kill -KILL $$" }))
        .details.task as Task;
      await expect.poll(() => send.mock.calls.length).toBe(1);
      expect(send.mock.calls[0]?.[0].details.tasks[0].outcome).toEqual({
        kind: "signaled",
        signal: "SIGKILL",
        code: 137,
      });
      expect(send.mock.calls[0]?.[1]).toEqual({
        deliverAs: mode === "tui" || mode === "rpc" ? "followUp" : "nextTurn",
        triggerTurn: mode === "tui" || mode === "rpc",
      });
      const status = await tool("bg_status")({ id: natural.id });
      expect(status.details.tasks[0]?.status).toBe("finished");
      for (const reason of ["reload", "new", "resume", "fork", "quit"]) {
        const running = (await tool("bg_run")({ command: "sleep 30" })).details
          .task as Task;
        await emit("session_shutdown", reason);
        expect(() => process.kill(running.pid, 0)).toThrow();
        await expect(tool("bg_status")({})).rejects.toThrow("not started");
        await emit("session_start", reason);
        expect((await tool("bg_status")({})).details.tasks).toEqual([]);
      }
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await emit("session_shutdown", "quit");
      await emit("session_shutdown", "quit");
      await rm(directory, { recursive: true, force: true });
      if (outputDir) await rm(outputDir, { recursive: true, force: true });
    }
  },
);
