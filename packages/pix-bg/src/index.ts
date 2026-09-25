import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getShellConfig,
} from "@earendil-works/pi-coding-agent";
import { privateDirectory } from "./directory.ts";
import { taskDetail, taskList } from "./format.ts";
import { Notifier } from "./notify.ts";
import { outputLimit, Registry } from "./registry.ts";
import { TaskUI } from "./ui.ts";

export default function backgroundTasks(pi: ExtensionAPI): void {
  let runtime:
    | { registry: Registry; notifier: Notifier; ui?: TaskUI }
    | undefined;

  function registry(): Registry {
    if (!runtime) throw new Error("Background task session has not started");
    return runtime.registry;
  }

  async function shutdown(): Promise<void> {
    const previous = runtime;
    runtime = undefined;
    if (!previous) return;
    previous.notifier.dispose();
    previous.ui?.dispose();
    await previous.registry.disposeAll();
  }

  pi.on("session_start", async (_event, ctx) => {
    await shutdown();
    // Linux /tmp is shared: a 0700 parent must be namespaced per OS user.
    const outputRoot = privateDirectory(
      join(tmpdir(), `pi-bg-${process.geteuid?.()}`),
    );
    const tasks = new Registry({
      shell: getShellConfig(),
      outputDir: join(outputRoot, ctx.sessionManager.getSessionId()),
      maxOutputBytes: outputLimit(process.env),
    });
    const notifier = new Notifier(
      (message, options) => pi.sendMessage(message, options),
      ctx.mode === "tui" || ctx.mode === "rpc",
    );
    const ui = ctx.mode === "tui" ? new TaskUI(tasks, ctx) : undefined;
    tasks.subscribe((task) => {
      ui?.update();
      if (task.status === "finished") notifier.completed(task);
    });
    runtime = { registry: tasks, notifier, ...(ui ? { ui } : {}) };
  });
  pi.on("session_shutdown", shutdown);

  pi.registerTool({
    name: "bg_run",
    label: "Background Run",
    description:
      "Start a background shell command. Completion wakes the agent; do not poll. Read output with read.",
    promptSnippet:
      "Run a shell command in the background with completion notification.",
    promptGuidelines: [
      "Never use bash sleep, blocking waits, or repeated bg_status/log checks to wait for background tasks.",
      "After bg_run, continue independent work or end the turn. In interactive/RPC mode, completion automatically starts another turn without user input.",
      ...(process.env.PIX_BG_SUBAGENT_HINTS === "0"
        ? []
        : [
            "In interactive/RPC sessions, you may delegate independent tasks through bg_run using pi --print --no-session. Give each child a self-contained task and necessary context; parent conversation history is not inherited. Run the child in the foreground (no &). Avoid overlapping file edits between agents.",
          ]),
    ],
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "Shell command" }),
      name: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 80,
          description: "Short task name",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          exclusiveMinimum: 0,
          maximum: 2147483.647,
          description: "Timeout in seconds; omitted means no timeout",
        }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const task = await registry().start({ ...params, cwd: ctx.cwd });
      return {
        content: [
          {
            type: "text",
            text: `${taskDetail(task)}\nCompletion notification is automatic in interactive/RPC mode; do not poll.`,
          },
        ],
        details: { task },
      };
    },
  });
  pi.registerTool({
    name: "bg_status",
    label: "Background Status",
    description:
      "Inspect one background task or list tasks in this runtime. Not a waiting tool.",
    promptSnippet: "Inspect background task status and output paths.",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({
          minLength: 1,
          description: "Exact task ID; omit to list",
        }),
      ),
    }),
    async execute(_id, { id }) {
      const tasks = id ? [registry().get(id)] : registry().list();
      return {
        content: [
          {
            type: "text",
            text: id && tasks[0] ? taskDetail(tasks[0]) : taskList(tasks),
          },
        ],
        details: { tasks },
      };
    },
  });
  pi.registerTool({
    name: "bg_kill",
    label: "Background Kill",
    description: "Stop a running background task and return its final state.",
    promptSnippet: "Stop a background task and its process group.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "Exact task ID" }),
    }),
    async execute(_id, { id }) {
      const task = await registry().stop(id, "agent");
      return {
        content: [{ type: "text", text: taskDetail(task) }],
        details: { task },
      };
    },
  });
  pi.registerCommand("bg", {
    description:
      "Inspect background tasks or toggle the status widget: /bg [toggle]",
    getArgumentCompletions(prefix) {
      return "toggle".startsWith(prefix)
        ? [{ value: "toggle", label: "toggle" }]
        : null;
    },
    async handler(args, ctx) {
      if (ctx.mode !== "tui")
        throw new Error("/bg requires interactive mode; use bg_status instead");
      if (!runtime?.ui)
        throw new Error("Background task session has not started");
      switch (args.trim()) {
        case "":
          await runtime.ui.show(ctx);
          break;
        case "toggle": {
          const visible = runtime.ui.toggleIndicator();
          ctx.ui.notify(
            `Background task widget ${visible ? "shown" : "hidden"}.`,
            "info",
          );
          break;
        }
        default:
          ctx.ui.notify("Usage: /bg [toggle]", "warning");
      }
    },
  });
}
