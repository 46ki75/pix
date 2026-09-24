import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
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

test.each([
  ["permissive", "parent"],
  ["symlink", "parent"],
  ["permissive", "session"],
  ["symlink", "session"],
])("rejects a %s log %s directory", async (kind, scope) => {
  const shared = await mkdtemp(join(tmpdir(), "pix-bg-shared-"));
  const parent = join(shared, `pi-bg-${userInfo().uid}`);
  const sessionId = "test-session";
  const unsafe = scope === "parent" ? parent : join(parent, sessionId);
  if (scope === "session") await mkdir(parent, { mode: 0o700 });
  if (kind === "symlink") {
    const target = join(shared, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, unsafe);
  } else {
    await mkdir(unsafe);
    await chmod(unsafe, 0o777);
  }
  const loaded = await discoverAndLoadExtensions(
    [fileURLToPath(new URL("../", import.meta.url))],
    shared,
    join(shared, "agent"),
  );
  expect(loaded.errors).toEqual([]);
  const extension = loaded.extensions[0];
  if (!extension) throw new Error("Extension did not load");
  const ctx = {
    mode: "print",
    cwd: shared,
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
  vi.stubEnv("TMPDIR", shared);
  try {
    const launch = async () => {
      for (const handler of extension.handlers.get("session_start") ?? [])
        await handler({ type: "session_start", reason: "startup" }, ctx);
      const tool = extension.tools.get("bg_run")?.definition;
      if (!tool) throw new Error("Missing bg_run tool");
      return tool.execute(
        "call",
        { command: "printf unsafe" },
        undefined,
        undefined,
        ctx,
      );
    };
    await expect(launch()).rejects.toThrow(
      "Unsafe background output directory",
    );
  } finally {
    for (const handler of extension.handlers.get("session_shutdown") ?? [])
      await handler({ type: "session_shutdown", reason: "quit" }, ctx);
    await rm(shared, { recursive: true, force: true });
  }
});

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
      ui: { setWidget: vi.fn() },
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
      expect(
        extension.tools.get("bg_run")?.definition.promptGuidelines,
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Never use bash sleep, blocking waits,"),
          expect.stringContaining("repeated bg_status/log checks"),
          expect.stringContaining("continue independent work or end the turn"),
          expect.stringContaining(
            "In interactive/RPC mode, completion automatically starts another turn without user input.",
          ),
        ]),
      );
      await expect(tool("bg_status")({})).rejects.toThrow("not started");
      await emit("session_start", "startup");
      expect(ctx.ui.setWidget).not.toHaveBeenCalled();
      const result = await tool("bg_run")({
        command: "sleep 30",
        name: "test sleeper",
      });
      const task = result.details.task as Task;
      if (mode === "tui")
        expect(ctx.ui.setWidget).toHaveBeenCalledWith(
          "pix-bg",
          expect.any(Function),
          { placement: "belowEditor" },
        );
      else expect(ctx.ui.setWidget).not.toHaveBeenCalled();
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
        if (mode === "tui")
          expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
            "pix-bg",
            undefined,
          );
        else expect(ctx.ui.setWidget).not.toHaveBeenCalled();
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
