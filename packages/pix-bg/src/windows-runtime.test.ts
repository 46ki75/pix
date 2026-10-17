import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Registry } from "./registry.ts";
import { WindowsExecutor } from "./windows-execution.ts";
import { windowsPowerShell } from "./windows.ts";

function bashQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function node(code: string): string {
  return `${bashQuote(process.execPath.replaceAll("\\", "/"))} -e ${bashQuote(code)}`;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

// IPC readiness travels up the fixture tree before its root exits or floods
// output. This proves the descendants existed, without scheduling-based sleeps.
function treeCode(marker: string, mode: "wait" | "exit" | "cap"): string {
  // Avoid libuv's own parent-exit job cleanup, but not pix-bg's outer job.
  // The negative control below proves these descendants survive without it.
  // https://github.com/libuv/libuv/blob/v1.x/src/win/process.c
  const options = JSON.stringify({
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    detached: process.platform === "win32",
    windowsHide: true,
  });
  const grandchild = `process.send("ready"); setInterval(() => {}, 1000);`;
  const child = `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], ${options});
    grandchild.once("message", () => process.send([process.pid, grandchild.pid]));
    setInterval(() => {}, 1000);
  `;
  return `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(child)}], ${options});
    child.once("message", (pids) => {
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, ...pids]));
      ${mode === "exit" ? "process.exit(0);" : mode === "cap" ? 'process.stdout.write("x".repeat(10000));' : ""}
    });
    setInterval(() => {}, 1000);
  `;
}

function tree(marker: string, mode: "wait" | "exit" | "cap"): string {
  return node(treeCode(marker, mode));
}

describe.runIf(process.platform === "win32")("native Windows runtime", () => {
  const fixtures: { root: string; registry: Registry }[] = [];
  const descendants = new Set<number>();

  afterEach(async () => {
    try {
      for (const { registry } of fixtures) await registry.disposeAll();
    } finally {
      // Assertions run before this fallback; runner cleanup must not conceal leaks.
      for (const pid of descendants) {
        if (running(pid)) process.kill(pid, "SIGKILL");
      }
      descendants.clear();
      for (const { root } of fixtures.splice(0))
        await rm(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  async function create(maxOutputBytes = 100_000, shell = getShellConfig()) {
    const root = await mkdtemp(join(tmpdir(), "pix-bg-win-"));
    const cwd = join(root, "work space ' 界");
    await mkdir(cwd);
    const registry = new Registry({
      executor: new WindowsExecutor({ shell }),
      outputDir: join(root, "logs"),
      maxOutputBytes,
    });
    fixtures.push({ root, registry });
    return { root, cwd, registry, marker: join(cwd, "ready.json") };
  }

  async function pids(marker: string): Promise<number[]> {
    let result: number[] = [];
    try {
      await expect
        .poll(
          async () => {
            try {
              result = JSON.parse(await readFile(marker, "utf8")) as number[];
              return result.length;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
              throw error;
            }
          },
          { timeout: 15_000 },
        )
        .toBe(3);
    } catch (cause) {
      const logs = await Promise.all(
        fixtures
          .flatMap(({ registry }) => registry.list())
          .map((task) => readFile(task.outputPath, "utf8")),
      );
      throw new Error(
        `Process-tree fixture did not become ready: ${logs.join("\n").slice(-8192)}`,
        { cause },
      );
    }
    for (const pid of result) {
      expect(pid).toBeGreaterThan(0);
      descendants.add(pid);
    }
    return result;
  }

  async function assertGone(ids: number[]) {
    for (const pid of ids)
      await expect.poll(() => running(pid), { timeout: 5000 }).toBe(false);
  }

  test("process-tree fixture descendants survive root exit without pix-bg supervision", async () => {
    const h = await create();
    const child = spawn(process.execPath, ["-e", treeCode(h.marker, "exit")], {
      cwd: h.cwd,
      stdio: "ignore",
      windowsHide: true,
    });
    if (child.pid) descendants.add(child.pid);
    await once(child, "close");
    expect(child.exitCode).toBe(0);
    const ids = await pids(h.marker);
    expect(ids[0]).toBe(child.pid);
    expect(ids.slice(1).map((pid) => running(pid))).toEqual([true, true]);
  });

  test.each([0, 7, 137])(
    "captures raw streams and reports native exit %i without invented signals",
    async (code) => {
      const h = await create();
      const task = await h.registry.start({
        command: node(
          `process.stdout.write("out界"); process.stderr.write("err"); process.exit(${code});`,
        ),
        cwd: h.cwd,
      });
      expect(task.pid).toBeGreaterThan(0);
      expect((await h.registry.wait(task.id)).outcome).toEqual({
        kind: "exited",
        code,
      });
      const text = await readFile(task.outputPath, "utf8");
      expect(text).toContain("out界");
      expect(text).toContain("err");
      await assertGone([task.pid]);
    },
  );

  test("preserves Unicode quoting, working directory, environment, and disconnected stdin", async () => {
    const h = await create();
    const value = `space ' quote " 界 \\ tail`;
    vi.stubEnv("PIX_BG_WINDOWS_TEST", value);
    const task = await h.registry.start({
      command: node(
        'let input = ""; process.stdin.on("data", data => input += data); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ cwd: process.cwd(), value: process.env.PIX_BG_WINDOWS_TEST, input })));',
      ),
      cwd: h.cwd,
    });
    expect((await h.registry.wait(task.id)).outcome).toEqual({
      kind: "exited",
      code: 0,
    });
    const result = JSON.parse(await readFile(task.outputPath, "utf8"));
    expect(await realpath(result.cwd as string)).toBe(await realpath(h.cwd));
    expect(result.value).toBe(value);
    expect(result.input).toBe("");
  });

  test.each([undefined, "", "C:\\custom PowerShell modules 界"])(
    "preserves the original PowerShell-specific environment: %j",
    async (modulePath) => {
      const h = await create();
      vi.stubEnv("PSModulePath", modulePath);
      vi.stubEnv("PSExecutionPolicyPreference", "RemoteSigned");
      const task = await h.registry.start({
        command: node(
          "process.stdout.write(JSON.stringify({ modulePath: process.env.PSModulePath ?? null, policy: process.env.PSExecutionPolicyPreference }))",
        ),
        cwd: h.cwd,
      });
      expect((await h.registry.wait(task.id)).outcome).toEqual({
        kind: "exited",
        code: 0,
      });
      expect(JSON.parse(await readFile(task.outputPath, "utf8"))).toEqual({
        modulePath: modulePath ?? null,
        policy: "RemoteSigned",
      });
    },
  );

  test.each([
    String.raw`a\b a\\b a\\\b a\\\\b`,
    String.raw`C:\Users\space ' " 界\file`,
    String.raw`\\\" \' \"`,
    "line one\nline two",
    "trailing \\\\",
  ])(
    "preserves Git Bash command text through MSYS argument decoding: %j",
    async (value) => {
      const h = await create();
      const task = await h.registry.start({
        command: `printf '%s' ${bashQuote(value)}`,
        cwd: h.cwd,
      });
      expect((await h.registry.wait(task.id)).outcome).toEqual({
        kind: "exited",
        code: 0,
      });
      expect(await readFile(task.outputPath, "utf8")).toBe(value);
    },
  );

  test("preserves split UTF-8 independently on stdout and stderr", async () => {
    const h = await create();
    const task = await h.registry.start({
      command: node(
        'process.stdout.write(Buffer.from([0xe7])); process.stderr.write("err"); setImmediate(() => process.stdout.write(Buffer.from([0x95, 0x8c])));',
      ),
      cwd: h.cwd,
    });
    expect((await h.registry.wait(task.id)).outcome).toEqual({
      kind: "exited",
      code: 0,
    });
    const output = await readFile(task.outputPath, "utf8");
    expect(output).toContain("界");
    expect(output).toContain("err");
    expect(output).not.toContain("�");
  });

  test.each(['space and "quote"', "界\\trailing\\"])(
    "quotes native arguments without corruption: %s",
    async (command) => {
      const h = await create(100_000, {
        shell: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        ],
      });
      const task = await h.registry.start({ command, cwd: h.cwd });
      expect((await h.registry.wait(task.id)).outcome).toEqual({
        kind: "exited",
        code: 0,
      });
      expect(JSON.parse(await readFile(task.outputPath, "utf8"))).toEqual([
        command,
      ]);
    },
  );

  test("shell exit terminates live descendants retaining both output pipes", async () => {
    const h = await create();
    const task = await h.registry.start({
      command: tree(h.marker, "exit"),
      cwd: h.cwd,
    });
    const done = await h.registry.wait(task.id);
    expect(done.outcome, await readFile(task.outputPath, "utf8")).toEqual({
      kind: "exited",
      code: 0,
    });
    await assertGone([task.pid, ...(await pids(h.marker))]);
  });

  test.each(["agent", "shutdown", "timeout", "cap"] as const)(
    "%s cleanup terminates children and grandchildren",
    async (cause) => {
      const h = await create(cause === "cap" ? 64 : 100_000);
      const task = await h.registry.start({
        command: tree(h.marker, cause === "cap" ? "cap" : "wait"),
        cwd: h.cwd,
        ...(cause === "timeout" ? { timeout: 10 } : {}),
      });
      const ids = await pids(h.marker);
      if (cause === "agent") await h.registry.stop(task.id, "agent");
      if (cause === "shutdown") await h.registry.disposeAll();
      const done = await h.registry.wait(task.id);
      expect(done.outcome).toEqual(
        cause === "timeout"
          ? { kind: "timed_out" }
          : cause === "cap"
            ? { kind: "output_capped" }
            : { kind: "killed", by: cause },
      );
      if (cause === "cap")
        expect((await readFile(task.outputPath)).length).toBe(64);
      await assertGone([task.pid, ...ids]);
    },
  );

  test("terminating the reported supervisor PID closes the job and never reports success", async () => {
    const h = await create();
    const task = await h.registry.start({
      command: tree(h.marker, "wait"),
      cwd: h.cwd,
    });
    const ids = await pids(h.marker);
    process.kill(task.pid, "SIGKILL");
    expect((await h.registry.wait(task.id)).outcome?.kind).toBe("failed");
    await assertGone([task.pid, ...ids]);
  });

  test("shutdown during launch joins a job-contained task", async () => {
    const h = await create();
    const launching = h.registry.start({
      command: node("setInterval(() => {}, 1000)"),
      cwd: h.cwd,
    });
    const disposal = h.registry.disposeAll();
    const task = await launching;
    await disposal;
    expect((await h.registry.wait(task.id)).outcome).toEqual({
      kind: "killed",
      by: "shutdown",
    });
    await assertGone([task.pid]);
  });

  test("runs the supervisor and bundled helpers from the packed npm artifact", async () => {
    const h = await create();
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const pack = `& pnpm --dir ${quote(packageRoot)} pack --pack-destination ${quote(h.root)}; exit $LASTEXITCODE`;
    execFileSync(
      windowsPowerShell(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(pack, "utf16le").toString("base64"),
      ],
      { timeout: 30_000, stdio: "pipe" },
    );
    const { version } = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    // Windows' tar can lose Unicode argv through its ANSI runtime. Move the
    // extracted tree with Node before testing the actual Unicode asset paths.
    const staging = join(h.root, "unpacked");
    await mkdir(staging);
    execFileSync(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
      ["-xf", join(h.root, `ikuma.cloud-pix-bg-${version}.tgz`), "-C", staging],
      { encoding: "utf8" },
    );
    const unpacked = join(h.cwd, "unpacked");
    await rename(staging, unpacked);
    // Use Node's source transform, not Vitest's resolver, so asset URLs must
    // resolve beside the actual packaged source in a path with spaces/Unicode.
    const script = `
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const source = process.env.PIX_BG_PACK_URL;
      const { WindowsExecutor } = await import(source);
      const { Registry } = await import(new URL("./registry.ts", source));
      const { privateWindowsDirectory, windowsUserId } = await import(new URL("./windows-directory.ts", source));
      const outputDir = join(process.cwd(), "packed logs 界");
      const registry = new Registry({ executor: new WindowsExecutor({ shell: JSON.parse(process.env.PIX_BG_PACK_SHELL) }), outputDir, maxOutputBytes: 1000 });
      try {
        const task = await registry.start({ command: "printf packed; exit 7", cwd: process.cwd() });
        const { outcome } = await registry.wait(task.id);
        privateWindowsDirectory(outputDir);
        process.stdout.write(JSON.stringify({ pid: task.pid, outcome, outputPath: task.outputPath, output: readFileSync(task.outputPath, "utf8"), userId: windowsUserId() }));
      } finally {
        await registry.disposeAll();
      }
    `;
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["--experimental-transform-types", "--input-type=module", "-e", script],
        {
          cwd: h.cwd,
          encoding: "utf8",
          timeout: 45_000,
          env: {
            ...process.env,
            PIX_BG_PACK_URL: pathToFileURL(
              join(unpacked, "package", "src", "windows-execution.ts"),
            ).href,
            PIX_BG_PACK_SHELL: JSON.stringify(getShellConfig()),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    expect(result).toEqual({
      pid: expect.any(Number),
      outcome: { kind: "exited", code: 7 },
      output: "packed",
      outputPath: expect.stringContaining("packed logs 界"),
      userId: expect.stringMatching(/^S-1-\d+(?:-\d+){1,15}$/),
    });
    const inspect = `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(result.outputPath as string, "utf8").toString("base64")}'))
$acl = [IO.File]::GetAccessControl($path)
[Console]::WriteLine($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value)
foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  [Console]::WriteLine(('{0}|{1}|{2}|{3}' -f $rule.IdentityReference.Value, [int]$rule.FileSystemRights, $rule.IsInherited, [int]$rule.AccessControlType))
}`;
    const [owner, ...rules] = execFileSync(
      windowsPowerShell(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(inspect, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", timeout: 15_000 },
    )
      .trim()
      .split(/\r?\n/);
    // Elevated tokens default file ownership to Administrators; the inherited
    // DACL, not that privileged owner, must still grant only this user/SYSTEM.
    // https://learn.microsoft.com/windows/win32/secauthz/owner-of-a-new-object
    expect([result.userId, "S-1-5-32-544"]).toContain(owner);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const [sid, rights, inherited, type] = rule.split("|");
      expect([result.userId, "S-1-5-18"]).toContain(sid);
      expect(Number(rights)).toBe(0x1f01ff);
      expect(inherited).toBe("True");
      expect(type).toBe("0");
    }
    expect(result.pid).toBeGreaterThan(0);
    await assertGone([result.pid as number]);
  });

  test("failed command launch rejects readiness and retains no task", async () => {
    const h = await create(100_000, {
      shell: "C:\\no-such-pix-bg-shell.exe",
      args: [],
    });
    await expect(
      h.registry.start({ command: "fixture", cwd: h.cwd }),
    ).rejects.toThrow();
    expect(h.registry.list()).toEqual([]);
  });

  test("concurrent stop requests preserve the first reason", async () => {
    const h = await create();
    const task = await h.registry.start({
      command: tree(h.marker, "wait"),
      cwd: h.cwd,
    });
    const ids = await pids(h.marker);
    const first = h.registry.stop(task.id, "user");
    const second = h.registry.stop(task.id, "agent");
    expect((await first).outcome).toEqual({ kind: "killed", by: "user" });
    expect((await second).outcome).toEqual({ kind: "killed", by: "user" });
    await assertGone([task.pid, ...ids]);
  });
});
