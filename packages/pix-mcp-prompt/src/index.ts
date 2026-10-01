import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Connection } from "./client.ts";
import { loadServers } from "./native.ts";
import { formatEditableContent, removeEditablePromptGuard } from "./output.ts";
import { inputPromptArgument } from "./prompt-argument-input.ts";
import { pickPrompt } from "./prompt-picker.ts";
import {
  formatPromptList,
  formatPromptResult,
  parsePromptCommand,
  promptCompletions,
  promptKey,
  resolvePromptArguments,
  type PromptArgumentToken,
  type PromptCommand,
  type PromptEntry,
} from "./prompts.ts";
import { compact } from "./text.ts";

interface State {
  alive: boolean;
  connections: Map<string, Connection>;
  prompts: Map<string, PromptEntry>;
  errors: string[];
  cleanups: Set<() => Promise<void>>;
  guards: Set<string>;
  syncing?: Promise<void>;
}

interface PromptSelection {
  command: PromptCommand;
  item: PromptEntry;
}

async function waitForCatalog(operation: Promise<void>, signal?: AbortSignal) {
  if (!signal) return operation;
  let onAbort: () => void = () => {};
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export default function mcpPrompt(pi: ExtensionAPI) {
  let state: State | undefined;

  function current(owner: State) {
    if (!owner.alive || state !== owner)
      throw new Error("MCP prompt session has ended.");
  }

  function clearServer(owner: State, name: string) {
    for (const [key, item] of owner.prompts)
      if (item.server === name) owner.prompts.delete(key);
  }

  function synchronize(owner: State, ctx: ExtensionContext): Promise<void> {
    if (owner.syncing) return owner.syncing;
    owner.syncing = (async () => {
      const loaded = await loadServers(ctx, pi.getMcpServers());
      current(owner);
      owner.errors = loaded.errors;
      const enabled = new Map(
        loaded.servers
          .filter((entry) => entry.config.enabled !== false)
          .map((entry) => [entry.name, entry]),
      );
      const closing: Promise<void>[] = [];
      for (const [name, connection] of owner.connections) {
        if (
          JSON.stringify(enabled.get(name)) === JSON.stringify(connection.entry)
        )
          continue;
        owner.connections.delete(name);
        clearServer(owner, name);
        closing.push(connection.close());
      }
      await Promise.all(closing);
      current(owner);
      for (const [name, entry] of enabled) {
        if (owner.connections.has(name)) continue;
        const connection = new Connection(entry, ctx, (prompts) => {
          // A replaced connection can finish a notification after close.
          if (
            !owner.alive ||
            state !== owner ||
            owner.connections.get(name) !== connection
          )
            return;
          clearServer(owner, name);
          for (const prompt of prompts)
            owner.prompts.set(promptKey(name, prompt.name), {
              server: name,
              prompt,
            });
        });
        owner.connections.set(name, connection);
      }
    })().finally(() => {
      delete owner.syncing;
    });
    return owner.syncing;
  }

  async function catalog(owner: State, ctx: ExtensionContext) {
    await synchronize(owner, ctx);
    const queue = [...owner.connections.values()];
    // Native Pi already owns its connections. Defer the additional prompt
    // connections until the user actually requests prompts, and bound fan-out.
    await waitForCatalog(
      Promise.all(
        Array.from({ length: Math.min(queue.length, 4) }, async () => {
          while (owner.alive && !ctx.signal?.aborted) {
            const connection = queue.shift();
            if (!connection) break;
            await connection.start().catch(() => {});
          }
        }),
      ).then(() => {}),
      ctx.signal,
    );
    current(owner);
    ctx.signal?.throwIfAborted();
  }

  async function choosePrompt(
    owner: State,
    ctx: ExtensionCommandContext,
  ): Promise<PromptSelection | undefined> {
    const entries = [...owner.prompts.values()].sort(
      (a, b) =>
        a.server.localeCompare(b.server, "en") ||
        a.prompt.name.localeCompare(b.prompt.name, "en"),
    );
    if (entries.length === 0) {
      const status = [
        ...owner.errors,
        ...[...owner.connections.values()].map(
          (connection) =>
            `${connection.entry.name}: ${connection.promptStatus}`,
        ),
      ].join("\n");
      ctx.ui.notify(
        `No MCP prompts are available.${status ? `\n${compact(status, 2000)}` : ""}`,
        "warning",
      );
      return;
    }
    const item = await pickPrompt(entries, ctx);
    if (!item) return;
    const ensureCurrent = () => {
      current(owner);
      ctx.signal?.throwIfAborted();
      if (owner.prompts.get(promptKey(item.server, item.prompt.name)) !== item)
        throw new Error("MCP prompt catalog changed. Open the picker again.");
    };
    ensureCurrent();
    const argumentTokens: PromptArgumentToken[] = [];
    for (const argument of item.prompt.arguments ?? []) {
      const description = compact(argument.description ?? "", 160);
      const value = await inputPromptArgument(ctx, {
        label: `${argument.name} (${argument.required ? "required" : "optional"})`,
        ...(description ? { description } : {}),
        guidance: argument.required ? "Enter a value" : "Leave empty to omit",
      });
      if (value === undefined) return;
      ensureCurrent();
      if (argument.required || value !== "")
        argumentTokens.push({
          value: `${argument.name}=${value}`,
          separator: argument.name.length,
        });
    }
    return {
      command: {
        action: "run",
        server: item.server,
        name: item.prompt.name,
        argumentTokens,
      },
      item,
    };
  }

  pi.registerCommand("mcp-prompt", {
    description: "Select, list, or run a user-controlled MCP prompt",
    getArgumentCompletions: (prefix) =>
      promptCompletions(prefix, [...(state?.prompts.values() ?? [])]),
    async handler(input, ctx) {
      try {
        const owner = state;
        if (!owner) throw new Error("MCP prompt session has not started.");
        current(owner);
        const editBeforeSending = ctx.mode === "tui" && input.trim() === "";
        // Reject bad command syntax before starting any prompt connections.
        const parsed = editBeforeSending
          ? undefined
          : parsePromptCommand(input);
        await catalog(owner, ctx);
        const selection = editBeforeSending
          ? await choosePrompt(owner, ctx)
          : undefined;
        const command = selection?.command ?? parsed;
        if (!command) return;
        if (command.action === "list") {
          if (command.server && !owner.connections.has(command.server))
            throw new Error("Unknown or disabled MCP server.");
          const status = [
            ...owner.errors.map((error) => compact(error, 1000)),
            ...[...owner.connections.values()]
              .filter(
                (connection) =>
                  !command.server || connection.entry.name === command.server,
              )
              .map(
                (connection) =>
                  `${connection.entry.name}: ${connection.promptStatus}`,
              ),
          ].join("\n");
          const text = `${status}${status ? "\n\n" : ""}${formatPromptList([...owner.prompts.values()], command.server)}`;
          if (!ctx.hasUI) throw new Error(text);
          ctx.ui.notify(text, "info");
          return;
        }
        const key = promptKey(command.server, command.name);
        const item = selection?.item ?? owner.prompts.get(key);
        if (!item)
          throw new Error(
            "Unknown or unavailable MCP prompt. List prompts again.",
          );
        const ensureCurrent = () => {
          current(owner);
          ctx.signal?.throwIfAborted();
          if (owner.prompts.get(key) !== item)
            throw new Error(
              "MCP prompt catalog changed. Select the prompt again.",
            );
        };
        ensureCurrent();
        const connection = owner.connections.get(command.server);
        if (!connection) throw new Error("MCP prompt connection unavailable.");
        const args = resolvePromptArguments(
          item.prompt,
          command.argumentTokens,
        );
        if (ctx.mode === "tui")
          ctx.ui.setStatus(
            "mcp-prompt",
            `Loading ${item.server} / ${item.prompt.name}…`,
          );
        try {
          const result = await connection.getPrompt(
            item.prompt.name,
            args,
            ctx.signal,
          );
          ensureCurrent();
          const formatted = await formatPromptResult(result);
          try {
            ensureCurrent();
            if (editBeforeSending) {
              const draft = await formatEditableContent(formatted.content);
              try {
                ensureCurrent();
                ctx.ui.pasteToEditor(draft.text);
                owner.cleanups.add(draft.cleanup);
                if (draft.guard) owner.guards.add(draft.guard);
              } catch (error) {
                await draft.cleanup();
                throw error;
              }
            } else {
              pi.sendUserMessage(formatted.content, {
                expandPromptTemplates: false,
                ...(ctx.isIdle() ? {} : { deliverAs: "followUp" as const }),
              });
            }
            owner.cleanups.add(formatted.cleanup);
          } catch (error) {
            await formatted.cleanup();
            throw error;
          }
        } finally {
          if (ctx.mode === "tui") ctx.ui.setStatus("mcp-prompt", undefined);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "MCP prompt failed.";
        if (!ctx.hasUI) throw new Error(message);
        ctx.ui.notify(message, "error");
      }
    },
  });

  async function stop() {
    const owner = state;
    if (!owner) return;
    owner.alive = false;
    state = undefined;
    owner.prompts.clear();
    owner.guards.clear();
    await Promise.allSettled([
      ...[...owner.connections.values()].map((connection) =>
        connection.close(),
      ),
      ...[...owner.cleanups].map((cleanup) => cleanup()),
    ]);
    owner.connections.clear();
    owner.cleanups.clear();
  }

  pi.on("session_start", async (_event, ctx) => {
    await stop();
    const owner: State = {
      alive: true,
      connections: new Map(),
      prompts: new Map(),
      errors: [],
      cleanups: new Set(),
      guards: new Set(),
    };
    state = owner;
    try {
      await synchronize(owner, ctx);
    } catch (error) {
      if (owner.alive) {
        owner.errors = [
          error instanceof Error
            ? error.message
            : "MCP prompt initialization failed.",
        ];
        if (ctx.hasUI) ctx.ui.notify(owner.errors[0]!, "error");
      }
    }
  });
  pi.on("session_shutdown", stop);
  pi.on("mcp_servers_change", async (_event, ctx) => {
    if (state) await synchronize(state, ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    // File-backed /mcp enable/disable changes have no public notification.
    // Reconcile at command/turn boundaries; /reload resets both clients.
    if (state) await synchronize(state, ctx);
  });
  pi.on("message_end", (event) => {
    const owner = state;
    if (!owner || event.message.role !== "user") return;
    const consumed = new Set<string>();
    const remove = (text: string) => {
      let next = text;
      for (const guard of owner.guards) {
        if (!next.includes(guard)) continue;
        next = removeEditablePromptGuard(next, guard);
        consumed.add(guard);
      }
      return next;
    };
    const content =
      typeof event.message.content === "string"
        ? remove(event.message.content)
        : event.message.content.map((block) =>
            block.type === "text"
              ? { ...block, text: remove(block.text) }
              : block,
          );
    for (const guard of consumed) owner.guards.delete(guard);
    if (consumed.size) return { message: { ...event.message, content } };
  });
}
