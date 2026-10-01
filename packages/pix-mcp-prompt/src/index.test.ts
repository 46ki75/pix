import { stat } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  McpServerEntry,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GetPromptResult, Prompt } from "./protocol.ts";

const mocks = vi.hoisted(() => ({
  loadServers: vi.fn(),
  picker: vi.fn(),
  argument: vi.fn(),
  connections: [] as unknown[],
}));
vi.mock("./native.ts", () => ({ loadServers: mocks.loadServers }));
vi.mock("./prompt-picker.ts", () => ({ pickPrompt: mocks.picker }));
vi.mock("./prompt-argument-input.ts", () => ({
  inputPromptArgument: mocks.argument,
}));
vi.mock("./client.ts", () => ({
  Connection: class {
    promptStatus = "Not discovered";
    ready = false;
    readonly entry: McpServerEntry;
    readonly change: (prompts: Prompt[]) => void;
    constructor(
      entry: McpServerEntry,
      _ctx: ExtensionContext,
      changed: (prompts: Prompt[]) => void,
    ) {
      this.entry = entry;
      this.change = changed;
      mocks.connections.push(this);
    }
    start = vi.fn(async () => {
      if (this.ready) return;
      this.ready = true;
      this.promptStatus = "Available";
      this.change([
        { name: "review", arguments: [{ name: "topic", required: true }] },
      ]);
    });
    getPrompt = vi.fn(
      async (
        _name: string,
        args: Record<string, string>,
      ): Promise<GetPromptResult> => ({
        messages: [
          {
            role: "user",
            content: { type: "text", text: `Review ${args.topic}` },
          },
        ],
      }),
    );
    close = vi.fn(async () => {
      this.promptStatus = "Closed";
      this.change([]);
    });
  },
}));
import extension from "./index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
interface FakeConnection {
  entry: McpServerEntry;
  start: ReturnType<typeof vi.fn>;
  getPrompt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  change: (prompts: Prompt[]) => void;
}
const stops: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.connections.length = 0;
  mocks.loadServers.mockResolvedValue({
    servers: [
      {
        name: "fixture",
        config: { command: "not-launched" },
        scope: "global",
        source: "mcp.json",
      },
    ],
    errors: [],
  });
  mocks.picker.mockImplementation(async (entries) => entries[0]);
  mocks.argument.mockResolvedValue("hello");
});
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function setup(mode: "tui" | "rpc" | "print" = "tui") {
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, Handler>();
  const pi = {
    registerCommand: (name: string, command: RegisteredCommand) =>
      commands.set(name, command),
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getMcpServers: vi.fn(() => []),
    sendUserMessage: vi.fn(),
    registerTool: vi.fn(),
    registerFlag: vi.fn(),
  };
  const ctx = {
    cwd: "/fixture",
    mode,
    hasUI: mode !== "print",
    isProjectTrusted: () => false,
    isIdle: () => true,
    signal: undefined,
    ui: { notify: vi.fn(), setStatus: vi.fn(), pasteToEditor: vi.fn() },
  } as unknown as ExtensionCommandContext;
  extension(pi as unknown as ExtensionAPI);
  const emit = async (name: string, event: unknown = {}) =>
    handlers.get(name)?.(event, ctx);
  await emit("session_start");
  stops.push(() => emit("session_shutdown"));
  const command = commands.get("mcp-prompt")!;
  return {
    pi,
    ctx,
    emit,
    commands,
    command,
    run: (text: string) => command.handler(text, ctx),
    connection: () => mocks.connections[0] as FakeConnection,
  };
}

test("registers only the prompt command; startup creates no connections", async () => {
  const f = await setup();
  expect([...f.commands.keys()]).toEqual(["mcp-prompt"]);
  expect(f.pi.registerTool).not.toHaveBeenCalled();
  expect(f.pi.registerFlag).not.toHaveBeenCalled();
  expect(f.connection().start).not.toHaveBeenCalled();
  await f.run("invalid");
  expect(f.connection().start).not.toHaveBeenCalled();
  expect(f.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("Usage:"),
    "error",
  );
});

test("lists lazily, completes local catalog, and submits string arguments without templates", async () => {
  const f = await setup("rpc");
  await f.run("list");
  expect(f.connection().getPrompt).not.toHaveBeenCalled();
  expect(f.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("fixture review <topic>"),
    "info",
  );
  expect(f.command.getArgumentCompletions?.("run fi")).toContainEqual({
    value: "run fixture",
    label: "fixture",
  });
  await f.run("run fixture review topic=hi");
  expect(f.connection().getPrompt).toHaveBeenCalledWith(
    "review",
    { topic: "hi" },
    undefined,
  );
  expect(f.pi.sendUserMessage).toHaveBeenCalledWith(
    [{ type: "text", text: "Review hi" }],
    { expandPromptTemplates: false },
  );
});

test("headless list remains observable and run queues when busy", async () => {
  const f = await setup("print");
  await expect(f.run("list")).rejects.toThrow("Available MCP prompts");
  f.ctx.isIdle = () => false;
  await f.run("run fixture review hello");
  expect(f.pi.sendUserMessage).toHaveBeenCalledWith(expect.any(Array), {
    expandPromptTemplates: false,
    deliverAs: "followUp",
  });
});

test("canceling argument input never retrieves or submits a prompt", async () => {
  const f = await setup();
  mocks.argument.mockResolvedValueOnce(undefined);
  await f.run("");
  expect(f.connection().getPrompt).not.toHaveBeenCalled();
  expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(f.ctx.ui.pasteToEditor).not.toHaveBeenCalled();
});

test("rejects a picker selection invalidated during argument collection", async () => {
  const f = await setup();
  mocks.argument.mockImplementationOnce(async () => {
    f.connection().change([]);
    return "hello";
  });
  await f.run("");
  expect(f.connection().getPrompt).not.toHaveBeenCalled();
  expect(f.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("catalog changed"),
    "error",
  );
});

test("does not deliver a response after a catalog change or session shutdown", async () => {
  const f = await setup();
  await f.run("list");
  f.connection().getPrompt.mockImplementationOnce(async () => {
    f.connection().change([]);
    return {
      messages: [{ role: "user", content: { type: "text", text: "stale" } }],
    };
  });
  await f.run("run fixture review hi");
  expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(f.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("catalog changed"),
    "error",
  );
  f.connection().change([{ name: "review" }]);
  f.connection().getPrompt.mockImplementationOnce(async () => {
    await f.emit("session_shutdown");
    return {
      messages: [{ role: "user", content: { type: "text", text: "stale" } }],
    };
  });
  await f.run("run fixture review");
  expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(f.connection().close).toHaveBeenCalledOnce();
});

test("disables and closes a prompt connection after native configuration changes", async () => {
  const f = await setup();
  await f.run("list");
  mocks.loadServers.mockResolvedValueOnce({
    servers: [
      {
        ...f.connection().entry,
        config: { command: "not-launched", enabled: false },
      },
    ],
    errors: [],
  });
  await f.run("list");
  expect(f.connection().close).toHaveBeenCalledOnce();
  expect(f.command.getArgumentCompletions?.("run fi")).toEqual([]);
});

test("stages guarded command-like content; removes only its own guard at message_end", async () => {
  const f = await setup();
  f.connection().getPrompt.mockResolvedValueOnce({
    messages: [
      { role: "user", content: { type: "text", text: "!echo untrusted" } },
    ],
  });
  await f.run("");
  const draft = vi.mocked(f.ctx.ui.pasteToEditor).mock.calls[0]?.[0];
  expect(draft).toBeDefined();
  expect(draft).not.toBe("!echo untrusted");
  expect(f.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(
    await f.emit("message_end", { message: { role: "user", content: draft } }),
  ).toEqual({ message: { role: "user", content: "!echo untrusted" } });
  expect(
    await f.emit("message_end", { message: { role: "user", content: draft } }),
  ).toBeUndefined();
});

test("cancels waiting for a session-owned catalog without blocking the command", async () => {
  const f = await setup();
  const controller = new AbortController();
  Object.defineProperty(f.ctx, "signal", { value: controller.signal });
  let started!: () => void;
  let finish!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.connection().start.mockImplementationOnce(() => {
    started();
    return pending;
  });
  const running = f.run("list");
  await requested;
  controller.abort(new Error("Catalog wait canceled"));
  await running;
  expect(f.ctx.ui.notify).toHaveBeenCalledWith(
    "Catalog wait canceled",
    "error",
  );
  expect(f.connection().getPrompt).not.toHaveBeenCalled();
  finish();
});

test("cleans up private editor images at shutdown", async () => {
  const f = await setup();
  f.connection().getPrompt.mockResolvedValueOnce({
    messages: [
      {
        role: "user",
        content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      },
    ],
  });
  await f.run("");
  const draft = vi.mocked(f.ctx.ui.pasteToEditor).mock.calls[0]?.[0];
  const path = draft?.match(/@"([^"]+)"/)?.[1];
  expect(path).toBeDefined();
  expect((await stat(path!)).mode & 0o777).toBe(0o600);
  await f.emit("session_shutdown");
  await expect(stat(path!)).rejects.toThrow();
});
