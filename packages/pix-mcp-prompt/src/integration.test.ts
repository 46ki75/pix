import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateToolCall, type JsonObject } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { promptKey } from "./prompts.ts";

interface TraceEvent {
  event: string;
  pid: number;
  label: string;
  revision: string;
  sequence: number;
  method?: string;
  params?: Record<string, unknown>;
  clientInfo?: Record<string, unknown>;
  signal?: string;
  code?: number;
}

interface SetupPaths {
  directory: string;
  agentDir: string;
  logPath: string;
}

type ServerMap = Record<string, unknown>;
type ServerMapOption =
  | ServerMap
  | null
  | ((paths: SetupPaths) => ServerMap | Promise<ServerMap>);

interface SetupOptions {
  projectTrusted?: boolean;
  mode?: ExtensionContext["mode"];
  withUI?: boolean;
  projectServers?: ServerMapOption;
  globalServers?: ServerMapOption;
  legacyServers?: ServerMapOption;
  prepare?: (paths: SetupPaths) => Promise<void>;
}

const fixturePath = fileURLToPath(
  new URL("./testing/raw-mcp-server.ts", import.meta.url),
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fixtureServer(
  logPath: string,
  label: string,
  revision = "1",
): Record<string, unknown> {
  return {
    command: process.execPath,
    args: [fixturePath],
    timeout: 3,
    exposure: "direct",
    env: {
      PIX_MCP_FIXTURE_LOG: logPath,
      PIX_MCP_FIXTURE_LABEL: label,
      PIX_MCP_FIXTURE_REVISION: revision,
    },
  };
}

async function resolveServers(
  option: ServerMapOption | undefined,
  paths: SetupPaths,
): Promise<ServerMap | null | undefined> {
  return typeof option === "function" ? option(paths) : option;
}

async function writeMcpConfig(path: string, servers: ServerMap): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ mcpServers: servers }));
}

async function readTrace(logPath: string): Promise<TraceEvent[]> {
  let source: string;
  try {
    source = await readFile(logPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return source
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TraceEvent];
      } catch {
        // A concurrent append can expose only the final partial line to a polling read.
        return [];
      }
    });
}

function startedPids(trace: TraceEvent[]): number[] {
  return trace
    .filter((event) => event.event === "start")
    .map((event) => event.pid);
}

function methodsFor(trace: TraceEvent[], pid: number): string[] {
  return trace
    .filter(
      (event) =>
        event.pid === pid &&
        (event.event === "request" || event.event === "notification"),
    )
    .flatMap((event) => (event.method ? [event.method] : []));
}

function pidForMethod(trace: TraceEvent[], method: string): number {
  const event = trace.find(
    (candidate) => candidate.event === "request" && candidate.method === method,
  );
  if (!event) throw new Error(`No fixture process received ${method}`);
  return event.pid;
}

async function setup(options: SetupOptions = {}) {
  const directory = await mkdtemp(
    join(tmpdir(), "pix-mcp-prompt-integration-"),
  );
  const agentDir = join(directory, "agent");
  const logPath = join(directory, "fixture.jsonl");
  const paths = { directory, agentDir, logPath };
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

  await options.prepare?.(paths);
  const projectServers =
    options.projectServers === undefined
      ? { project: fixtureServer(logPath, "project") }
      : await resolveServers(options.projectServers, paths);
  const globalServers = await resolveServers(options.globalServers, paths);
  const legacyServers = await resolveServers(options.legacyServers, paths);
  const projectConfigPath = join(directory, ".pi", "mcp.json");
  const globalConfigPath = join(agentDir, "mcp.json");
  const legacyConfigPath = join(directory, ".mcp.json");
  if (projectServers) await writeMcpConfig(projectConfigPath, projectServers);
  if (globalServers) await writeMcpConfig(globalConfigPath, globalServers);
  if (legacyServers) await writeMcpConfig(legacyConfigPath, legacyServers);

  const projectTrusted = options.projectTrusted ?? true;
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted });
  settingsManager.setProjectTrusted(projectTrusted);
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir,
    settingsManager,
    noExtensions: true,
    extensionFactories: [createMcpExtension({ startupWaitMs: 3_000 })],
    additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-cache.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const modelRequests = [
    vi.spyOn(modelRuntime, "stream"),
    vi.spyOn(modelRuntime, "streamSimple"),
    vi.spyOn(modelRuntime, "complete"),
    vi.spyOn(modelRuntime, "completeSimple"),
  ];
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager: SessionManager.inMemory(directory),
  });

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  };
  cleanups.push(shutdown);

  const uiContext = { ...session.extensionRunner.getUIContext() };
  const notify = vi.spyOn(uiContext, "notify");
  const custom = vi.spyOn(uiContext, "custom");
  const pasteToEditor = vi.spyOn(uiContext, "pasteToEditor");
  const setStatus = vi.spyOn(uiContext, "setStatus");
  const errors: string[] = [];
  await session.bindExtensions({
    mode: options.mode ?? "print",
    ...(options.withUI === false ? {} : { uiContext }),
    onError: (error) => errors.push(error.error),
  });

  // A successful prompt command deliberately starts a model turn. Capture that
  // public extension action at the SDK boundary so these tests never select or call a model.
  const sendUserMessage = vi.fn();
  resourceLoader.getExtensions().runtime.sendUserMessage = sendUserMessage;

  async function callTool(name: string, args: JsonObject) {
    const tools = session.agent.state.tools;
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Inactive tool: ${name}`);
    const params = validateToolCall(tools, {
      type: "toolCall",
      id: `integration-${name}`,
      name,
      arguments: args,
    });
    return tool.execute(`integration-${name}`, params, undefined);
  }

  function expectNoModelRequests(): void {
    for (const request of modelRequests) expect(request).not.toHaveBeenCalled();
  }

  async function writeProjectServers(servers: ServerMap): Promise<void> {
    await writeMcpConfig(projectConfigPath, servers);
  }

  return {
    directory,
    agentDir,
    logPath,
    projectConfigPath,
    resourceLoader,
    session,
    shutdown,
    notify,
    custom,
    pasteToEditor,
    setStatus,
    errors,
    sendUserMessage,
    callTool,
    expectNoModelRequests,
    writeProjectServers,
  };
}

test("keeps native MCP tools and resources while prompts use one lazy prompt-only connection", async () => {
  const integration = await setup();
  const {
    session,
    resourceLoader,
    logPath,
    notify,
    sendUserMessage,
    callTool,
  } = integration;

  const commands = session.extensionRunner
    .getRegisteredCommands()
    .map((command) => command.name);
  expect(commands).toEqual(expect.arrayContaining(["mcp", "mcp-prompt"]));
  const promptExtension = resourceLoader
    .getExtensions()
    .extensions.find((extension) => extension.commands.has("mcp-prompt"));
  expect(promptExtension).toBeDefined();
  expect(promptExtension?.commands.size).toBe(1);
  expect(promptExtension?.tools.size).toBe(0);
  expect(promptExtension?.flags.size).toBe(0);

  // `/mcp` awaits the built-in extension's background startup promise.
  await session.prompt("/mcp");
  let trace = await readTrace(logPath);
  expect(startedPids(trace)).toHaveLength(1);
  const nativePid = pidForMethod(trace, "tools/list");
  expect(methodsFor(trace, nativePid)).toEqual(
    expect.arrayContaining([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "resources/list",
      "resources/templates/list",
    ]),
  );
  expect(methodsFor(trace, nativePid)).not.toContain("prompts/list");
  expect(session.getActiveToolNames()).toEqual(
    expect.arrayContaining([
      "mcp__project__echo",
      "list_mcp_resources",
      "read_mcp_resource",
    ]),
  );

  const toolResult = await callTool("mcp__project__echo", {
    message: "native call",
  });
  expect(toolResult.content[0]).toMatchObject({
    type: "text",
    text: "project:native call",
  });
  const listed = await callTool("list_mcp_resources", { server: "project" });
  expect(listed.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("fixture://project"),
  });
  const resource = await callTool("read_mcp_resource", {
    server: "project",
    uri: "fixture://project",
  });
  expect(resource.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("Resource from project revision 1"),
  });

  await session.prompt("/mcp-prompt list project");
  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining("project review <topic> [tone]"),
    "info",
  );
  trace = await readTrace(logPath);
  expect(startedPids(trace)).toHaveLength(2);
  const promptPid = pidForMethod(trace, "prompts/list");
  expect(promptPid).not.toBe(nativePid);
  expect(methodsFor(trace, promptPid)).toEqual(
    expect.arrayContaining([
      "initialize",
      "notifications/initialized",
      "prompts/list",
    ]),
  );
  expect(
    methodsFor(trace, promptPid).some(
      (method) =>
        method.startsWith("tools/") || method.startsWith("resources/"),
    ),
  ).toBe(false);
  const initializations = trace.filter(
    (event) => event.event === "request" && event.method === "initialize",
  );
  expect(
    initializations.find((event) => event.pid === nativePid)?.clientInfo,
  ).toMatchObject({ name: "pi" });
  expect(
    initializations.find((event) => event.pid === promptPid)?.clientInfo?.name,
  ).toMatch(/^(?:pi|pix-mcp-prompt)$/u);

  await session.prompt('/mcp-prompt run project review "the API" tone=concise');
  expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith(
    [{ type: "text", text: "Review the API in a concise tone." }],
    { expandPromptTemplates: false },
  );
  trace = await readTrace(logPath);
  expect(startedPids(trace)).toHaveLength(2);
  expect(methodsFor(trace, promptPid)).toContain("prompts/get");
  integration.expectNoModelRequests();
});

test("uses native Streamable HTTP headers with separate prompt-only requests", async () => {
  const requests: Array<{ method: string; authorization: string | undefined }> =
    [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(request.method === "DELETE" ? 204 : 405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number;
      method: string;
    };
    requests.push({
      method: message.method,
      authorization: request.headers.authorization,
    });
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const results: Record<string, unknown> = {
      initialize: {
        protocolVersion: "2025-11-25",
        capabilities: { prompts: {} },
        serverInfo: { name: "local-http", version: "1" },
      },
      "prompts/list": { prompts: [{ name: "review" }] },
      "prompts/get": {
        messages: [
          { role: "user", content: { type: "text", text: "HTTP prompt" } },
        ],
      },
    };
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: results[message.method] ?? {},
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing HTTP fixture address");
  vi.stubEnv("PIX_PROMPT_HTTP_TOKEN", "Bearer isolated-fixture");
  const integration = await setup({
    projectServers: {
      http: {
        url: `http://127.0.0.1:${address.port}/mcp`,
        // oxlint-disable-next-line eslint/no-template-curly-in-string -- Native MCP, not JavaScript, expands the configuration value.
        headers: { Authorization: "${PIX_PROMPT_HTTP_TOKEN}" },
        timeout: 3,
      },
    },
  });
  await integration.session.prompt("/mcp");
  expect(requests.filter(({ method }) => method === "initialize")).toHaveLength(
    1,
  );
  await integration.session.prompt("/mcp-prompt run http review");
  expect(integration.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
    [{ type: "text", text: "HTTP prompt" }],
    { expandPromptTemplates: false },
  );
  expect(requests.filter(({ method }) => method === "initialize")).toHaveLength(
    2,
  );
  expect(
    requests.filter(({ method }) => method === "prompts/list"),
  ).toHaveLength(1);
  expect(
    requests.every(
      ({ authorization }) => authorization === "Bearer isolated-fixture",
    ),
  ).toBe(true);
  expect(
    requests.some(({ method }) => /^(tools|resources)\//u.test(method)),
  ).toBe(false);
  integration.expectNoModelRequests();
});

test("integrates TUI prompt picking, guarded drafts, stale notifications, and cancellation", async () => {
  const integration = await setup({ mode: "tui" });
  const {
    session,
    logPath,
    custom,
    pasteToEditor,
    notify,
    setStatus,
    sendUserMessage,
  } = integration;
  custom
    .mockResolvedValueOnce(promptKey("project", "review"))
    .mockResolvedValueOnce("command")
    .mockResolvedValueOnce("");

  await session.prompt("/mcp-prompt");

  expect(custom).toHaveBeenCalledTimes(3);
  const draft = pasteToEditor.mock.calls[0]?.[0];
  expect(draft).toContain("!echo unsafe");
  expect(draft).not.toMatch(/^!/u);
  expect(sendUserMessage).not.toHaveBeenCalled();
  expect(setStatus).toHaveBeenCalledWith(
    "mcp-prompt",
    "Loading project / review…",
  );
  expect(setStatus).toHaveBeenLastCalledWith("mcp-prompt", undefined);
  if (!draft) throw new Error("Missing editor draft");
  const dispatched = await session.extensionRunner.emitMessageEnd({
    type: "message_end",
    message: {
      role: "user",
      content: [{ type: "text", text: draft }],
      timestamp: Date.now(),
    },
  });
  expect(dispatched).toMatchObject({
    role: "user",
    content: [{ type: "text", text: "!echo unsafe" }],
  });

  await session.prompt("/mcp-prompt run project stale");
  expect(notify).toHaveBeenLastCalledWith(
    "MCP prompt catalog changed. Select the prompt again.",
    "error",
  );
  expect(sendUserMessage).not.toHaveBeenCalled();
  await vi.waitFor(async () => {
    const trace = await readTrace(logPath);
    expect(
      trace.filter(
        (event) => event.event === "request" && event.method === "prompts/list",
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  const command = session.extensionRunner
    .getRegisteredCommands()
    .find((candidate) => candidate.name === "mcp-prompt");
  if (!command) throw new Error("Missing /mcp-prompt command");
  const controller = new AbortController();
  const context = Object.create(
    session.extensionRunner.createCommandContext(),
  ) as ExtensionCommandContext;
  Object.defineProperty(context, "signal", { value: controller.signal });
  const blocked = command.handler("run project blocked", context);
  await vi.waitFor(async () => {
    const trace = await readTrace(logPath);
    expect(
      trace.some(
        (event) =>
          event.event === "request" &&
          event.method === "prompts/get" &&
          event.params?.name === "blocked",
      ),
    ).toBe(true);
  });
  controller.abort(new Error("Fixture prompt cancelled"));
  await expect(blocked).resolves.toBeUndefined();
  await vi.waitFor(async () => {
    const trace = await readTrace(logPath);
    expect(
      trace.some(
        (event) =>
          event.event === "notification" &&
          event.method === "notifications/cancelled",
      ),
    ).toBe(true);
  });
  expect(notify).toHaveBeenLastCalledWith("Fixture prompt cancelled", "error");
  integration.expectNoModelRequests();
});

test("rejects bad headless syntax before connecting and runs explicit headless prompts", async () => {
  const integration = await setup({ withUI: false });
  const { session, logPath, errors, sendUserMessage } = integration;

  await session.prompt("/mcp");
  expect(startedPids(await readTrace(logPath))).toHaveLength(1);

  await session.prompt("/mcp-prompt invalid");
  expect(errors).toContainEqual(expect.stringContaining("Usage: /mcp-prompt"));
  expect(startedPids(await readTrace(logPath))).toHaveLength(1);

  await session.prompt("/mcp-prompt list project");
  expect(errors).toContainEqual(
    expect.stringContaining("Available MCP prompts:"),
  );
  expect(startedPids(await readTrace(logPath))).toHaveLength(2);

  await session.prompt(
    "/mcp-prompt run project review topic=headless tone=direct",
  );
  expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith(
    [{ type: "text", text: "Review headless in a direct tone." }],
    { expandPromptTemplates: false },
  );
  integration.expectNoModelRequests();
});

test.each([
  { trusted: true, expectedLabels: ["global", "project"] },
  { trusted: false, expectedLabels: ["global"] },
])(
  "uses global and trusted native config while ignoring disabled and legacy servers (trusted=$trusted)",
  async ({ trusted, expectedLabels }) => {
    const integration = await setup({
      projectTrusted: trusted,
      globalServers: ({ logPath }) => ({
        global: fixtureServer(logPath, "global"),
        disabled: {
          ...fixtureServer(logPath, "disabled"),
          enabled: false,
        },
      }),
      projectServers: ({ logPath }) => ({
        project: fixtureServer(logPath, "project"),
      }),
      legacyServers: ({ logPath }) => ({
        legacy: fixtureServer(logPath, "legacy"),
      }),
    });
    const { session, logPath, notify } = integration;

    await session.prompt("/mcp");
    let trace = await readTrace(logPath);
    expect(
      trace
        .filter((event) => event.event === "start")
        .map((event) => event.label)
        .sort(),
    ).toEqual([...expectedLabels].sort());

    await session.prompt("/mcp-prompt list");
    trace = await readTrace(logPath);
    expect(
      trace
        .filter((event) => event.event === "start")
        .map((event) => event.label)
        .sort(),
    ).toEqual([...expectedLabels, ...expectedLabels].sort());
    const list = notify.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("Available MCP prompts:"));
    expect(list).toBeDefined();
    for (const label of expectedLabels)
      expect(list).toContain(`${label} review`);
    expect(list).not.toContain("disabled review");
    expect(list).not.toContain("legacy review");
    if (!trusted) expect(list).not.toContain("project review");
    integration.expectNoModelRequests();
  },
);

test.each([true, false])(
  "respects project enabled-state overrides in both clients (trusted=%s)",
  async (trusted) => {
    const integration = await setup({
      projectTrusted: trusted,
      globalServers: ({ logPath }) => ({
        global: fixtureServer(logPath, "global"),
      }),
      projectServers: { global: { enabled: false } },
    });
    const { session, logPath, notify, errors } = integration;

    await session.prompt("/mcp");
    expect(startedPids(await readTrace(logPath))).toHaveLength(trusted ? 0 : 1);
    await session.prompt("/mcp-prompt list");
    expect(notify).toHaveBeenLastCalledWith(
      trusted
        ? "No MCP prompts are available."
        : expect.stringContaining("global review"),
      "info",
    );
    expect(startedPids(await readTrace(logPath))).toHaveLength(trusted ? 0 : 2);
    expect(errors).toEqual([]);
    integration.expectNoModelRequests();
  },
);

test("replaces changed prompt connections without disturbing native MCP and closes all on shutdown", async () => {
  const integration = await setup();
  const { session, logPath, writeProjectServers, shutdown } = integration;

  await session.prompt("/mcp");
  await session.prompt("/mcp-prompt list project");
  let trace = await readTrace(logPath);
  const nativePid = pidForMethod(trace, "tools/list");
  const oldPromptPid = pidForMethod(trace, "prompts/list");
  expect(startedPids(trace)).toHaveLength(2);

  await writeProjectServers({
    project: fixtureServer(logPath, "project", "2"),
  });
  await session.prompt("/mcp-prompt list project");
  trace = await readTrace(logPath);
  expect(startedPids(trace)).toHaveLength(3);
  const newPromptRequest = trace.find(
    (event) =>
      event.event === "request" &&
      event.method === "prompts/list" &&
      event.revision === "2",
  );
  expect(newPromptRequest?.pid).toBeTypeOf("number");
  expect(newPromptRequest?.pid).not.toBe(oldPromptPid);
  expect(
    trace.some(
      (event) => event.pid === oldPromptPid && event.event === "stdin_end",
    ),
  ).toBe(true);
  expect(
    trace.some(
      (event) => event.pid === nativePid && event.event === "stdin_end",
    ),
  ).toBe(false);

  await shutdown();
  trace = await readTrace(logPath);
  for (const pid of new Set(startedPids(trace))) {
    expect(
      trace.some(
        (event) =>
          event.pid === pid &&
          (event.event === "stdin_end" || event.event === "signal"),
      ),
    ).toBe(true);
  }
  integration.expectNoModelRequests();
});

test("runs the built Copilot CLI with roots, arguments, attachments, and live catalog changes", async () => {
  // Build outside the checkout so a clean CI run needs no pre-existing dist/
  // and cannot race another package's build or overwrite a developer's output.
  const build = await mkdtemp(join(tmpdir(), "pix-copilot-build-"));
  cleanups.push(() => rm(build, { recursive: true, force: true }));
  const serverPackage = fileURLToPath(
    new URL("../../mcp-copilot-prompts/", import.meta.url),
  );
  const tsc = fileURLToPath(
    new URL("../../../node_modules/typescript/bin/tsc", import.meta.url),
  );
  await promisify(execFile)(process.execPath, [
    tsc,
    "--project",
    join(serverPackage, "tsconfig.build.json"),
    "--outDir",
    build,
  ]);
  await writeFile(
    join(build, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await symlink(
    join(serverPackage, "node_modules"),
    join(build, "node_modules"),
    "junction",
  );
  const cliPath = join(build, "cli.js");
  const integration = await setup({
    prepare: async ({ directory }) => {
      const promptDirectory = join(directory, ".github", "prompts");
      await mkdir(promptDirectory, { recursive: true });
      await writeFile(
        join(promptDirectory, "review.prompt.md"),
        [
          "---",
          "name: review-api",
          "description: Review an API",
          "---",
          ["Review $", "{input:api:API name}."].join(""),
          "[Context](notes.md)",
          "![Diagram](diagram.png)",
        ].join("\n"),
      );
      await writeFile(join(promptDirectory, "notes.md"), "Attached API notes");
      await writeFile(
        join(promptDirectory, "diagram.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN4cAAAAASUVORK5CYII=",
          "base64",
        ),
      );
    },
    projectServers: {
      copilot: {
        command: process.execPath,
        args: [cliPath],
        timeout: 5,
        exposure: "direct",
      },
    },
  });
  const { session, sendUserMessage } = integration;

  await session.prompt("/mcp");
  await session.prompt("/mcp-prompt run copilot review-api api=billing");

  expect(sendUserMessage).toHaveBeenCalledOnce();
  const content = sendUserMessage.mock.calls[0]?.[0];
  expect(content).toEqual(
    expect.arrayContaining([
      { type: "text", text: expect.stringContaining("Review billing.") },
      { type: "image", mimeType: "image/png", data: expect.any(String) },
    ]),
  );
  expect(JSON.stringify(content)).toContain("Attached API notes");

  await writeFile(
    join(integration.directory, ".github", "prompts", "review.prompt.md"),
    "---\nname: revised\n---\nChanged prompt body.\n",
  );
  const command = session.extensionRunner
    .getRegisteredCommands()
    .find((candidate) => candidate.name === "mcp-prompt");
  await vi.waitFor(
    () => {
      expect(
        command?.getArgumentCompletions?.("run copilot revised"),
      ).toContainEqual({ value: "run copilot revised", label: "revised" });
    },
    { timeout: 5000 },
  );
  await session.prompt("/mcp-prompt run copilot revised");
  expect(sendUserMessage).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(sendUserMessage.mock.calls[1]?.[0])).toContain(
    "Changed prompt body.",
  );
  integration.expectNoModelRequests();
}, 30_000);
