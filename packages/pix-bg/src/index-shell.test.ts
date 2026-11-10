import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getPowerShellConfig,
  getShellConfig,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExecutionObserver } from "./execution.ts";
import backgroundTasks from "./index.ts";
import type { Task } from "./registry.ts";
import { powerShellCommand } from "./shell.ts";

vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
  getShellConfig: vi.fn(),
  getPowerShellConfig: vi.fn(),
}));
vi.mock("./directory.ts", async () => {
  const { mkdirSync } = await import("node:fs");
  return {
    outputUserId: () => "test-user",
    privateDirectory: (path: string) => {
      mkdirSync(path, { recursive: true });
      return path;
    },
  };
});
const { launch, configure } = vi.hoisted(() => ({
  launch: vi.fn(),
  configure: vi.fn(),
}));
vi.mock("./windows-execution.ts", () => ({
  WindowsExecutor: class {
    constructor(options: unknown) {
      configure(options);
    }
    start = launch;
  },
}));
vi.mock("./posix-execution.ts", () => ({
  PosixExecutor: class {
    constructor(options: unknown) {
      configure(options);
    }
    start = launch;
  },
}));

const bash = { shell: "C:\\Git\\bin\\bash.exe", args: ["-c"] };
const powershell = {
  shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  args: [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
  ],
};
const cleanup: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("process", { ...process, platform: "win32" });
  vi.mocked(getShellConfig).mockReturnValue(bash);
  vi.mocked(getPowerShellConfig).mockReturnValue(powershell);
  launch.mockImplementation(
    (_command: string, _cwd: string, observer: ExecutionObserver) => ({
      pid: 123,
      ready: Promise.resolve(),
      stop() {
        queueMicrotask(() => {
          observer.onExit({ kind: "exited", code: 1 });
          observer.onComplete();
        });
      },
    }),
  );
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function create() {
  const directory = await mkdtemp(join(tmpdir(), "pix-bg-shell-"));
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    on: (
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => handlers.set(event, handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
  };
  backgroundTasks(pi as unknown as ExtensionAPI);
  const ctx = {
    mode: "print",
    cwd: directory,
    sessionManager: { getSessionId: () => basename(directory) },
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
  cleanup.push(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    await rm(join(tmpdir(), "pi-bg-test-user", basename(directory)), {
      recursive: true,
      force: true,
    });
    await rm(directory, { recursive: true, force: true });
  });
  await handlers.get("session_start")?.({}, ctx);
  return {
    tools,
    async run(params: Record<string, unknown>) {
      const result = await tools
        .get("bg_run")!
        .execute("call", params, undefined, undefined, ctx);
      return (result.details as { task: Task }).task;
    },
  };
}

test("resolves shells only at launch and preserves Bash as the default", async () => {
  const h = await create();
  expect(getShellConfig).not.toHaveBeenCalled();
  expect(getPowerShellConfig).not.toHaveBeenCalled();
  const task = await h.run({ command: "printf bash" });
  expect(getShellConfig).toHaveBeenCalledOnce();
  expect(getPowerShellConfig).not.toHaveBeenCalled();
  expect(configure).toHaveBeenCalledExactlyOnceWith({ shell: bash });
  expect(launch).toHaveBeenCalledWith(
    "printf bash",
    expect.any(String),
    expect.any(Object),
  );
  expect(task).toMatchObject({ command: "printf bash", shell: "bash" });
});

test("PowerShell-only sessions do not discover or require Bash", async () => {
  vi.mocked(getShellConfig).mockImplementation(() => {
    throw new Error("No bash shell found");
  });
  const h = await create();
  const task = await h.run({
    command: "Write-Output '界'",
    shell: "powershell",
  });
  expect(getShellConfig).not.toHaveBeenCalled();
  expect(getPowerShellConfig).toHaveBeenCalledOnce();
  expect(configure).toHaveBeenCalledExactlyOnceWith({ shell: powershell });
  expect(launch.mock.calls[0]?.[0]).toContain("[Console]::OutputEncoding");
  expect(launch.mock.calls[0]?.[0]).toContain("Write-Output '界'");
  expect(task).toMatchObject({
    command: "Write-Output '界'",
    shell: "powershell",
  });
});

test("can mix explicitly selected Bash and PowerShell tasks in one session", async () => {
  const h = await create();
  await h.run({ command: "printf bash", shell: "bash" });
  await h.run({ command: "Write-Output powershell", shell: "powershell" });
  await h.run({ command: "printf bash-again" });
  expect(getShellConfig).toHaveBeenCalledTimes(2);
  expect(getPowerShellConfig).toHaveBeenCalledOnce();
  expect(launch.mock.calls.map(([command]) => command)).toEqual([
    "printf bash",
    expect.stringContaining("Write-Output powershell"),
    "printf bash-again",
  ]);
});

test.each(["darwin", "linux"])(
  "rejects PowerShell on %s without changing Bash behavior",
  async (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    const h = await create();
    await expect(
      h.run({ command: "Write-Output no", shell: "powershell" }),
    ).rejects.toThrow("only available on Windows");
    expect(getPowerShellConfig).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    await h.run({ command: "printf ok" });
    expect(launch).toHaveBeenCalledOnce();
  },
);

test.each(["pwsh.exe", "C:\\Program Files\\PowerShell\\7\\PWSH.EXE"])(
  "PowerShell 7 receives UTF-8 setup without Windows PowerShell's exit suffix: %s",
  (shell) => {
    const command = "Write-Output 'quotes \\\" and \\\\ 界'\nexit 7";
    expect(powerShellCommand(command, shell)).toBe(
      `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${command}`,
    );
  },
);

test("Windows PowerShell exit handling preserves unfinished statements and trailing backticks", () => {
  const shell =
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.exe";
  const suffix = powerShellCommand("Write-Output ok", shell);
  expect(suffix).toContain("\n;\nif ($?) { exit 0 }");
  expect(suffix).toContain("NativeCommandError*");
  expect(suffix).toMatch(/exit 1$/);
  expect(powerShellCommand("Get-ChildItem |", shell)).toContain(
    "Get-ChildItem |\n;\n",
  );
  expect(powerShellCommand("Write-Output ok`", shell)).toMatch(/ok`$/);
});

test("advertises shell syntax and rejects unknown shells rather than falling back", async () => {
  const h = await create();
  const definition = h.tools.get("bg_run")!;
  expect(definition.parameters).toMatchObject({
    properties: { shell: expect.any(Object) },
  });
  expect(definition.description).toContain("PowerShell");
  await expect(h.run({ command: "echo no", shell: "cmd" })).rejects.toThrow(
    "Unsupported background shell",
  );
  expect(launch).not.toHaveBeenCalled();
});
