import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DEFAULT_MAX_OUTPUT_BYTES, outputLimit, Registry } from "./registry.ts";

const registries: Registry[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    registries.splice(0).map((registry) => registry.disposeAll()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function create(maxOutputBytes = 1024 * 1024, shell = "/bin/sh") {
  const outputDir = await mkdtemp(join(tmpdir(), "pix-bg-test-"));
  directories.push(outputDir);
  const registry = new Registry({
    shell: { shell, args: ["-c"] },
    outputDir,
    maxOutputBytes,
    graceMs: 100,
  });
  registries.push(registry);
  return registry;
}

function node(code: string): string {
  return `'${process.execPath}' -e '${code.replaceAll("'", "'\\''")}'`;
}

function isRunning(pid: number): boolean {
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return state.length > 0 && !state.startsWith("Z");
  } catch {
    return false;
  }
}

test.each([0, 3])(
  "records exit %i and captures stdout/stderr",
  async (code) => {
    const registry = await create();
    const task = await registry.start({
      command: `printf out; printf err >&2; exit ${code}`,
      cwd: tmpdir(),
    });
    const finished = await registry.wait(task.id);
    expect(finished.outcome).toEqual({ kind: "exited", code });
    const output = await readFile(task.outputPath, "utf8");
    expect(output).toContain("out");
    expect(output).toContain("err");
    expect(finished.outputBytes).toBe(6);
    expect((await stat(task.outputPath)).mode & 0o777).toBe(0o600);
    expect(finished.endedAt).toBeGreaterThanOrEqual(finished.startedAt);
    expect(task.status).toBe("running");
  },
);

test.each([
  ["TERM", 143],
  ["KILL", 137],
] as const)("reports SIG%s rather than success", async (signal, code) => {
  const registry = await create();
  const task = await registry.start({
    command: `kill -${signal} $$`,
    cwd: tmpdir(),
  });
  expect((await registry.wait(task.id)).outcome).toEqual({
    kind: "signaled",
    signal: `SIG${signal}`,
    code,
  });
});

test("times out and escalates when SIGTERM is ignored", async () => {
  const registry = await create();
  const task = await registry.start({
    command: "trap '' TERM; while :; do sleep 1; done",
    timeout: 0.1,
    cwd: tmpdir(),
  });
  expect((await registry.wait(task.id)).outcome).toEqual({ kind: "timed_out" });
  expect(isRunning(task.pid)).toBe(false);
});

test("caps stored output exactly and kills a noisy task", async () => {
  const registry = await create(1001);
  const task = await registry.start({
    command: "while :; do printf 'abcdef'; done",
    cwd: tmpdir(),
  });
  const finished = await registry.wait(task.id);
  expect(finished.outcome).toEqual({ kind: "output_capped" });
  expect(finished.outputBytes).toBe(1001);
  expect((await stat(task.outputPath)).size).toBe(1001);
  expect(isRunning(task.pid)).toBe(false);
});

test("does not cap output exactly at the limit", async () => {
  const registry = await create(3);
  const task = await registry.start({ command: "printf abc", cwd: tmpdir() });
  expect((await registry.wait(task.id)).outcome).toEqual({
    kind: "exited",
    code: 0,
  });
});

test("decodes split UTF-8 and strips split ANSI sequences and binary controls", async () => {
  const registry = await create();
  const task = await registry.start({
    command: node(
      `process.stdout.write(Buffer.from([0xe7])); setTimeout(() => { process.stdout.write(Buffer.from([0x95,0x8c])); process.stdout.write("\\x1b["); setTimeout(() => process.stdout.write("31mred\\x1b[0m\\x00\\n"), 20); }, 20);`,
    ),
    cwd: tmpdir(),
  });
  await registry.wait(task.id);
  expect(await readFile(task.outputPath, "utf8")).toBe("界red\n");
});

test.each([
  "sleep 30 & echo $!",
  "(trap '' TERM; exec sleep 30) >/dev/null 2>&1 & echo $!; sleep 0.1",
])("cleans up children after shell exit: %s", async (command) => {
  const registry = await create();
  const task = await registry.start({ command, cwd: tmpdir() });
  expect((await registry.wait(task.id)).outcome).toEqual({
    kind: "exited",
    code: 0,
  });
  const pid = Number((await readFile(task.outputPath, "utf8")).trim());
  expect(pid).toBeGreaterThan(0);
  await expect.poll(() => isRunning(pid)).toBe(false);
});

test.each(["agent", "user", "shutdown"] as const)(
  "records %s stop reason before sending signals",
  async (by) => {
    const registry = await create();
    const task = await registry.start({ command: "sleep 30", cwd: tmpdir() });
    const finished = await registry.stop(task.id, by);
    expect(finished.outcome).toEqual({ kind: "killed", by });
    expect(isRunning(task.pid)).toBe(false);
    await expect(registry.stop(task.id, by)).rejects.toThrow("already exited");
  },
);

test("disposal is idempotent, rejects new starts, and preserves logs", async () => {
  const registry = await create();
  const tasks = await Promise.all(
    ["sleep 30", "sleep 31"].map((command) =>
      registry.start({ command, cwd: tmpdir() }),
    ),
  );
  const first = registry.disposeAll();
  expect(registry.disposeAll()).toBe(first);
  await first;
  for (const task of tasks) {
    expect(registry.get(task.id).outcome).toEqual({
      kind: "killed",
      by: "shutdown",
    });
    expect(isRunning(task.pid)).toBe(false);
    await expect(stat(task.outputPath)).resolves.toBeDefined();
  }
  await expect(
    registry.start({ command: "true", cwd: tmpdir() }),
  ).rejects.toThrow("shut down");
});

test("rejects unknown IDs, invalid input, and spawn errors without retaining tasks", async () => {
  const registry = await create();
  expect(() => registry.get("missing")).toThrow("Unknown");
  await expect(registry.start({ command: " ", cwd: tmpdir() })).rejects.toThrow(
    "empty",
  );
  for (const timeout of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2147484,
  ]) {
    await expect(
      registry.start({ command: "true", cwd: tmpdir(), timeout }),
    ).rejects.toThrow("Timeout");
  }
  const bad = await create(100, "/no/such/shell");
  await expect(bad.start({ command: "true", cwd: tmpdir() })).rejects.toThrow(
    "ENOENT",
  );
  expect(bad.list()).toEqual([]);
});

test("validates the environment cap", () => {
  expect(outputLimit({})).toBe(DEFAULT_MAX_OUTPUT_BYTES);
  expect(outputLimit({ PIX_BG_MAX_OUTPUT_BYTES: " 123 " })).toBe(123);
  for (const value of ["0", "-1", "1.5", "abc", "Infinity"]) {
    expect(() => outputLimit({ PIX_BG_MAX_OUTPUT_BYTES: value })).toThrow(
      "positive safe integer",
    );
  }
});
