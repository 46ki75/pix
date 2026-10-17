import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Registry } from "./registry.ts";
import { WindowsExecutor } from "./windows-execution.ts";
import { windowsPowerShell } from "./windows.ts";

function node(code: string): string {
  const executable = process.execPath.replaceAll("\\", "/");
  return `'${executable.replaceAll("'", "'\\''")}' -e '${code.replaceAll("'", "'\\''")}'`;
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
function tree(marker: string, mode: "wait" | "exit" | "cap"): string {
  const grandchild = `process.send("ready"); setInterval(() => {}, 1000);`;
  const child = `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    grandchild.once("message", () => process.send([process.pid, grandchild.pid]));
    setInterval(() => {}, 1000);
  `;
  return node(`
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    child.once("message", (pids) => {
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, ...pids]));
      ${mode === "exit" ? "process.exit(0);" : mode === "cap" ? 'process.stdout.write("x".repeat(10000));' : ""}
    });
    setInterval(() => {}, 1000);
  `);
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
    expect((await h.registry.wait(task.id)).outcome).toEqual({
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
    const unpacked = join(h.cwd, "unpacked");
    await mkdir(unpacked);
    execFileSync("tar.exe", [
      "-xf",
      join(h.root, `ikuma.cloud-pix-bg-${version}.tgz`),
      "-C",
      unpacked,
    ]);
    // Use Node's source transform, not Vitest's resolver, so asset URLs must
    // resolve beside the actual packaged source in a path with spaces/Unicode.
    const script = `
      const { WindowsExecutor } = await import(process.env.PIX_BG_PACK_URL);
      let finish, outcome, failure, output = "";
      const done = new Promise(resolve => finish = resolve);
      const execution = new WindowsExecutor({ shell: JSON.parse(process.env.PIX_BG_PACK_SHELL) }).start("printf packed; exit 7", process.cwd(), {
        onData(source, chunk) { if (source === "stdout") output += chunk.toString("utf8"); },
        onOutputError(error) { failure = error.message; },
        onSpawnError(error) { failure = error.message; },
        onExit(value) { outcome = value; },
        onComplete() { finish(); }
      });
      await execution.ready;
      await done;
      process.stdout.write(JSON.stringify({ pid: execution.pid, outcome, output, failure }));
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
    });
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
