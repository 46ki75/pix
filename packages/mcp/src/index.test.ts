import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  Type,
  validateToolCall,
  type AssistantMessage,
  type JsonObject,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { tinyPng } from "./fixtures/server.ts";
import { toolName } from "./catalog.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  options: {
    trust?: boolean;
    extension?: (pi: ExtensionAPI) => void;
    broken?: boolean;
    invalidSchema?: boolean;
    legacySchema?: boolean;
    booleanSchema?: boolean;
    tools?: string[];
    twoServers?: boolean;
    extraServers?: Record<string, unknown>;
    configValue?: unknown;
    source?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pix-mcp-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const fixture = fileURLToPath(
    new URL("./fixtures/server.ts", import.meta.url),
  );
  const definition = {
    command: process.execPath,
    args: [fixture],
    timeout: 2000,
    startupTimeoutMs: 2000,
    catalogTimeoutMs: 2000,
    env: {
      ...(options.invalidSchema ? { PIX_FIXTURE_INVALID_SCHEMA: "true" } : {}),
      ...(options.legacySchema ? { PIX_FIXTURE_LEGACY_SCHEMA: "true" } : {}),
      ...(options.booleanSchema !== undefined
        ? { PIX_FIXTURE_BOOLEAN_SCHEMA: String(options.booleanSchema) }
        : {}),
    },
  };
  await writeFile(
    join(directory, ".mcp.json"),
    options.source ??
      JSON.stringify(
        options.configValue !== undefined
          ? options.configValue
          : {
              mcpServers: {
                fixture: definition,
                ...options.extraServers,
                ...(options.twoServers ? { other: definition } : {}),
                ...(options.broken
                  ? {
                      broken: {
                        ...definition,
                        env: { PIX_FIXTURE_BROKEN: "true" },
                      },
                    }
                  : {}),
              },
            },
      ),
  );
  const agentDir = join(directory, "agent");
  const settingsManager = SettingsManager.inMemory();
  let unrelatedApi: ExtensionAPI | undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir,
    settingsManager,
    noExtensions: true,
    extensionFactories: [
      (pi) => {
        unrelatedApi = pi;
        options.extension?.(pi);
      },
    ],
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  if (options.trust !== false)
    resourceLoader
      .getExtensions()
      .runtime.flagValues.set("mcp-trust-config", true);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-cache.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager: SessionManager.inMemory(directory),
    ...(options.tools ? { tools: options.tools } : {}),
  });
  cleanups.push(async () => {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  });
  const errors: string[] = [];
  await session.bindExtensions({
    onError: (error) => errors.push(error.error),
  });
  expect(errors).toEqual([]);
  async function call(name: string, args: JsonObject, signal?: AbortSignal) {
    const tools = session.agent.state.tools;
    const tool = tools.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Inactive tool: ${name}`);
    const params = validateToolCall(tools, {
      type: "toolCall",
      id: "fixture-call",
      name,
      arguments: args,
    });
    return tool.execute("fixture-call", params, signal);
  }
  async function discover(args: JsonObject) {
    const response = await call("mcp", args);
    const content = response.content[0];
    if (content?.type !== "text") throw new Error("Missing discovery output");
    return JSON.parse(content.text) as {
      status: string;
      items: { name: string; tool: string; active: boolean }[];
      total: number;
      nextOffset?: number;
      servers: { name: string; status: string; unsupportedTools: number }[];
    };
  }
  function registerUnrelated() {
    if (!unrelatedApi) throw new Error("Missing test extension");
    unrelatedApi.registerTool({
      name: "unrelated",
      label: "Unrelated",
      description: "Unrelated test tool",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: "unrelated" }],
          details: undefined,
        };
      },
    });
  }
  async function requestTools(toolCalls: ToolCall[] = []) {
    let observed: Tool[] | undefined;
    session.agent.state.model = {
      id: "fixture",
      name: "Fixture",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "http://127.0.0.1:1",
      reasoning: false,
      input: ["text"],
      contextWindow: 100_000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    session.agent.getApiKey = () => "fixture-not-a-credential";
    session.agent.streamFunction = (model, context) => {
      const callTools = observed === undefined && toolCalls.length > 0;
      const stopReason = callTools ? "toolUse" : "stop";
      observed = getCurrentTools(context.messages);
      const message: AssistantMessage = {
        role: "assistant",
        content: callTools ? toolCalls : [{ type: "text", text: "fixture" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: stopReason, message });
      stream.end();
      return stream;
    };
    await session.agent.prompt("Fixture request; no network/model call.");
    expect(session.agent.state.errorMessage).toBeUndefined();
    if (!observed) throw new Error("Provider boundary was not reached");
    return observed;
  }
  return { session, call, discover, registerUnrelated, requestTools };
}

test("Pi loads the package, holds native schemas inactive, then activates and calls a tool", async () => {
  const { session, call, discover } = await setup();
  const initial = session.getActiveToolNames();
  expect(initial).toContain("read");
  expect(initial).toContain("mcp");
  expect(initial.filter((name) => name.startsWith("mcp_"))).toEqual([]);
  const listed = await discover({ action: "list", limit: 2 });
  expect(listed.total).toBe(5);
  expect(listed.items).toHaveLength(2);
  expect(listed.nextOffset).toBe(2);
  expect(listed.items.every((item) => !item.active)).toBe(true);
  const found = await discover({ action: "search", query: "echo" });
  const name = found.items[0]?.name;
  expect(name).toBeDefined();
  if (!name) throw new Error("Missing echo");
  expect(found.items[0]?.active).toBe(true);
  expect(session.getActiveToolNames()).toEqual([...initial, name]);
  expect(
    session.agent.state.tools.find((tool) => tool.name === name)?.parameters,
  ).toMatchObject({ required: ["message"], additionalProperties: false });
  const result = await call(name, { message: "Hello MCP" });
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("Hello MCP"),
  });
  await expect(call(name, {})).rejects.toThrow("Validation failed");
  await expect(
    discover({ action: "load", names: ["unknown"] }),
  ).rejects.toThrow("Unknown");
  expect(session.getActiveToolNames()).toContain("read");
});

test.each(["schema", "rename"])(
  "Pi explicit allowlists preserve lazy activation and withdrawal (%s)",
  async (changeKind) => {
    const echo = toolName("fixture", "echo");
    const change = toolName("fixture", "change");
    const other = toolName("other", "echo");
    const { session, call, discover } = await setup({
      tools: ["mcp", echo, change, other],
      twoServers: true,
    });
    expect(session.getActiveToolNames()).toEqual(["mcp"]);
    await discover({ action: "load", names: [echo, change] });
    await call(change, { message: changeKind });
    await expect.poll(() => session.getActiveToolNames()).not.toContain(echo);
    expect(session.getActiveToolNames()).not.toContain(other);
    expect(session.getActiveToolNames()).toContain(change);
  },
);

test.each([false, true])(
  "unrelated registration cannot expose or authorize deferred native tools (changed=%s)",
  async (changed) => {
    const echo = toolName("fixture", "echo");
    const change = toolName("fixture", "change");
    const { session, call, discover, registerUnrelated, requestTools } =
      await setup({ tools: ["mcp", echo, change, "unrelated"] });
    if (changed) {
      await discover({ action: "load", names: [echo, change] });
      expect((await requestTools()).some((tool) => tool.name === echo)).toBe(
        true,
      );
      await call(change, { message: "schema" });
      await expect.poll(() => session.getActiveToolNames()).not.toContain(echo);
    }
    registerUnrelated();
    await expect(call(echo, { message: "not selected" })).rejects.toThrow();
    const exposed = await requestTools();
    expect(exposed.some((tool) => tool.name === echo)).toBe(false);
    expect(exposed.some((tool) => tool.name === "unrelated")).toBe(true);
    await discover({ action: "load", names: [echo] });
    expect((await requestTools()).some((tool) => tool.name === echo)).toBe(
      true,
    );
    expect(
      (await call(echo, { message: "selected" })).content[0],
    ).toMatchObject({ text: expect.stringContaining("selected") });
  },
);

test("headless sessions do not trust a bare project config", async () => {
  const untrusted = await setup({ trust: false });
  expect((await untrusted.discover({ action: "list" })).status).toContain(
    "not trusted",
  );
  expect(
    untrusted.session
      .getAllTools()
      .filter((tool) => tool.name.startsWith("mcp_")),
  ).toEqual([]);
});

test.each([false, true])(
  "trusted native calls need no adapter approval (interactive=%s)",
  async (interactive) => {
    const { session, discover, call } = await setup();
    const confirm = vi.fn(async () => false);
    if (interactive)
      session.extensionRunner.setUIContext(
        { ...session.extensionRunner.getUIContext(), confirm },
        "tui",
      );
    expect(session.extensionRunner.hasUI()).toBe(interactive);
    const found = await discover({ action: "search", query: "echo" });
    const name = found.items[0]?.name ?? "";
    expect(session.getToolDefinition(name)?.executionMode).toBe("parallel");
    const message = "x".repeat(9000);
    expect((await call(name, { message })).content[0]).toMatchObject({
      text: expect.stringContaining(message),
    });
    expect(confirm).not.toHaveBeenCalled();
  },
);

test.each(["allow", "block", "error"] as const)(
  "external Pi policy can %s native MCP calls through normal tool hooks",
  async (policy) => {
    const name = toolName("fixture", "change");
    const onCall = vi.fn();
    const onResult = vi.fn();
    const { session, discover, requestTools } = await setup({
      extension(pi) {
        pi.on("tool_call", (event) => {
          if (event.toolName !== name) return;
          onCall(event);
          if (policy === "error") throw new Error("Fixture policy failed");
          if (policy === "block")
            return { block: true, reason: "Blocked by fixture policy" };
        });
        pi.on("tool_result", (event) => {
          if (event.toolName === name) onResult(event);
        });
      },
    });
    await discover({ action: "load", names: [name] });
    await requestTools([
      {
        type: "toolCall",
        id: "policy-call",
        name,
        arguments: { message: "rename" },
      },
    ]);
    expect(onCall).toHaveBeenCalledExactlyOnceWith({
      type: "tool_call",
      toolName: name,
      toolCallId: "policy-call",
      input: { message: "rename" },
    });
    const result = session.agent.state.messages.find(
      (message) =>
        message.role === "toolResult" && message.toolCallId === "policy-call",
    );
    expect(result).toMatchObject({
      isError: policy !== "allow",
      content: [
        {
          type: "text",
          text: expect.stringContaining(
            policy === "allow"
              ? "rename"
              : policy === "block"
                ? "Blocked by fixture policy"
                : "Fixture policy failed",
          ),
        },
      ],
    });
    // The change tool renames echo, so a blocked call must leave it unchanged.
    if (policy === "allow") {
      expect(onResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ toolName: name, isError: false }),
      );
      await expect
        .poll(async () => (await discover({ action: "list" })).items)
        .toContainEqual(expect.objectContaining({ tool: "echo_v2" }));
    } else {
      // Pi's tool_result hook runs only for executed calls, not policy denials.
      expect(onResult).not.toHaveBeenCalled();
      expect((await discover({ action: "list" })).items).toContainEqual(
        expect.objectContaining({ tool: "echo" }),
      );
    }
  },
);

test("one failed server does not hide healthy tools or leak transport errors", async () => {
  const { discover } = await setup({ broken: true });
  const result = await discover({ action: "list" });
  expect(result.total).toBe(5);
  expect(
    result.servers.find((server) => server.name === "broken")?.status,
  ).not.toBe("Connected");
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

test("configuration failures are visible while healthy tools remain trust-gated and usable", async () => {
  vi.stubEnv("PIX_FIXTURE_UNSET_SECRET", undefined);
  const extraServers = {
    invalid: { command: "SECRET-command", timeout: 0 },
    missingEnv: {
      type: "http",
      url: "https://example.test",
      headers: { Authorization: `\${PIX_FIXTURE_UNSET_SECRET}` },
    },
    legacy: { command: "SECRET-command", timeoutMs: 960000 },
    "SECRET\ninvalid-name": { command: "SECRET-command" },
  };
  const { discover, call } = await setup({ extraServers });
  const listed = await discover({ action: "list" });
  expect(listed.total).toBe(5);
  expect(listed.servers).toHaveLength(5);
  expect(listed.status).toContain("invalid");
  expect(JSON.stringify(listed)).not.toContain("SECRET");
  expect(
    listed.servers.find((server) => server.name === "legacy")?.status,
  ).toContain("Removed; use timeout");
  const invalid = await discover({ action: "list", server: "invalid" });
  expect(invalid.items).toEqual([]);
  expect(
    invalid.servers.find((server) => server.name === "invalid")?.status,
  ).toContain("timeout");
  const found = await discover({ action: "search", query: "echo" });
  expect(
    (await call(found.items[0]?.name ?? "", { message: "healthy" })).content[0],
  ).toMatchObject({ text: expect.stringContaining("healthy") });
  const untrusted = await setup({ extraServers, trust: false });
  const blocked = await untrusted.discover({ action: "list" });
  expect(blocked.status).toContain("not trusted");
  expect(blocked.servers).toEqual([]);
  expect(blocked.items).toEqual([]);
});

test("invalid-only configuration and root errors have safe, distinct discovery results", async () => {
  const invalid = await setup({
    configValue: { mcpServers: { broken: { timeout: 0, command: "SECRET" } } },
  });
  const result = await invalid.discover({ action: "list" });
  expect(result.items).toEqual([]);
  expect(result.servers).toHaveLength(1);
  expect(result.status).toContain("No valid");
  expect(JSON.stringify(result)).not.toContain("SECRET");
  for (const source of ['{"SECRET":', JSON.stringify({ mcpServers: [] })]) {
    const broken = await setup({ source });
    const root = await broken.discover({ action: "list" });
    expect(root.status).toContain("Invalid MCP configuration");
    expect(root.items).toEqual([]);
    expect(root.servers).toEqual([]);
    expect(JSON.stringify(root)).not.toContain("SECRET");
  }
});

test("native calls report MCP errors and spill oversized results to private files", async () => {
  const { call, discover } = await setup();
  const listed = await discover({ action: "list" });
  const names = listed.items
    .filter((item) => ["fail", "large"].includes(item.tool))
    .map((item) => item.name);
  await discover({ action: "load", names });
  const fail = listed.items.find((item) => item.tool === "fail")?.name ?? "";
  const large = listed.items.find((item) => item.tool === "large")?.name ?? "";
  await expect(call(fail, { message: "x" })).rejects.toThrow(
    "Fixture tool failure",
  );
  const result = await call(large, { message: "x" });
  const details = result.details as {
    fullOutputPath: string;
    truncated: boolean;
  };
  expect(details.truncated).toBe(true);
  expect(await readFile(details.fullOutputPath, "utf8")).toContain(
    "Fixture output",
  );
  cleanups.push(() =>
    rm(join(details.fullOutputPath, ".."), { recursive: true, force: true }),
  );
});

test("malformed schemas never become native tools, while healthy tools remain usable", async () => {
  const { session, call, discover } = await setup({ invalidSchema: true });
  const listed = await discover({ action: "list" });
  expect(listed.total).toBe(5);
  expect(listed.servers[0]?.unsupportedTools).toBe(1);
  expect(
    session.getAllTools().some((tool) => tool.name.includes("invalid")),
  ).toBe(false);
  const found = await discover({ action: "search", query: "echo" });
  expect(
    (await call(found.items[0]?.name ?? "", { message: "healthy" })).content[0],
  ).toMatchObject({ text: expect.stringContaining("healthy") });
});

test.each([true, false])(
  "native tools preserve boolean input properties (%s)",
  async (allowed) => {
    const { session, call, discover } = await setup({ booleanSchema: allowed });
    expect((await discover({ action: "list" })).total).toBe(6);
    const found = await discover({ action: "search", query: "boolean" });
    const name = found.items[0]?.name ?? "";
    expect(session.getToolDefinition(name)?.parameters).toMatchObject({
      properties: { payload: allowed },
    });
    if (allowed)
      await expect(call(name, { payload: 42 })).resolves.toBeDefined();
    else
      await expect(call(name, { payload: 42 })).rejects.toThrow(
        "Validation failed",
      );
    await expect(call(name, {})).resolves.toBeDefined();
  },
);

test("unrepresentable legacy reference semantics are rejected before native exposure", async () => {
  const { session, call, discover } = await setup({ legacySchema: true });
  const listed = await discover({ action: "list" });
  expect(listed.total).toBe(5);
  expect(listed.servers[0]?.unsupportedTools).toBe(1);
  expect(
    session.getAllTools().some((tool) => tool.name.includes("legacy")),
  ).toBe(false);
  const found = await discover({ action: "search", query: "echo" });
  expect(
    (await call(found.items[0]?.name ?? "", { message: "healthy" })).content[0],
  ).toMatchObject({ text: expect.stringContaining("healthy") });
});

test.each(["image", "structured-error"])(
  "MCP error images remain available in a private full-result artifact (%s)",
  async (messageKind) => {
    const { call, discover } = await setup();
    const found = await discover({ action: "search", query: "fail" });
    const error = await call(found.items[0]?.name ?? "", {
      message: messageKind,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Fixture tool failure");
    const path = /Full MCP result: (.+)/.exec(message)?.[1];
    expect(path).toBeDefined();
    if (!path) throw new Error("Error discarded its image without an artifact");
    cleanups.push(() => rm(join(path, ".."), { recursive: true, force: true }));
    expect(JSON.parse(await readFile(path, "utf8")).content).toContainEqual({
      type: "image",
      mimeType: "image/png",
      data: tinyPng,
    });
  },
);

test("list-change notifications withdraw stale tools without affecting Pi tools", async () => {
  const { session, call, discover } = await setup();
  const listed = await discover({ action: "list" });
  const echo = listed.items.find((item) => item.tool === "echo")?.name ?? "";
  const change =
    listed.items.find((item) => item.tool === "change")?.name ?? "";
  await discover({ action: "load", names: [echo, change] });
  await call(change, { message: "change catalog" });
  await expect.poll(() => session.getActiveToolNames()).not.toContain(echo);
  const result = await discover({ action: "list" });
  expect(
    result.items.some((item) => item.tool === "echo_v2" && !item.active),
  ).toBe(true);
  expect(session.getActiveToolNames()).toContain("read");
  expect(session.getActiveToolNames()).toContain(change);
});

test("changed schemas require reloading and stale native tool references fail closed", async () => {
  const { session, call, discover } = await setup();
  const listed = await discover({ action: "list" });
  const echo = listed.items.find((item) => item.tool === "echo")?.name ?? "";
  const change =
    listed.items.find((item) => item.tool === "change")?.name ?? "";
  await discover({ action: "load", names: [echo, change] });
  const stale = session.agent.state.tools.find((tool) => tool.name === echo);
  if (!stale) throw new Error("Missing active tool");
  await call(change, { message: "schema" });
  await expect.poll(() => session.getActiveToolNames()).not.toContain(echo);
  await discover({ action: "load", names: [echo] });
  await expect(stale.execute("stale", { message: "valid" })).rejects.toThrow(
    "changed",
  );
  await expect(call(echo, { message: "x" })).rejects.toThrow(
    "Validation failed",
  );
  expect((await call(echo, { message: "valid" })).content[0]).toMatchObject({
    text: expect.stringContaining("valid"),
  });
});

test("cancelling one call leaves concurrent sibling calls usable; shutdown withdraws tools", async () => {
  const { session, call, discover } = await setup();
  const found = await discover({ action: "search", query: "slow" });
  const name = found.items[0]?.name ?? "";
  const abort = new AbortController();
  const cancelled = call(
    name,
    { message: "cancel", delay: 1000 },
    abort.signal,
  );
  const rejection = expect(cancelled).rejects.toThrow();
  const sibling = call(name, { message: "sibling", delay: 20 });
  abort.abort();
  await rejection;
  expect((await sibling).content[0]).toMatchObject({
    text: expect.stringContaining("sibling"),
  });
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "new",
  });
  expect(session.getActiveToolNames()).not.toContain(name);
  expect(session.getActiveToolNames()).toContain("read");
  await session.bindExtensions({});
  expect(session.getActiveToolNames()).not.toContain(name);
  expect((await discover({ action: "list" })).total).toBe(5);
});
