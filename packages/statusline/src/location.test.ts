import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { formatDirectory, resolveLocation } from "./location.ts";

const execFileAsync = promisify(execFile);
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
};
const exec: ExtensionAPI["exec"] = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    ...options,
    env,
  });
  return { stdout, stderr, code: 0, killed: false };
};
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pix-statusline-location-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function initRepository(path: string) {
  await mkdir(path, { recursive: true });
  await exec("git", ["init", "--template=", "--initial-branch=main"], {
    cwd: path,
  });
}

test("uses the repository basename and relative path, even before the first commit", async () => {
  const root = join(directory, "repo with spaces ");
  const nested = join(root, "packages", "statusline");
  await initRepository(root);
  await mkdir(nested, { recursive: true });
  expect(await resolveLocation(root, exec)).toBe(" repo with spaces ");
  expect(await resolveLocation(nested, exec)).toBe(
    " repo with spaces /packages/statusline",
  );

  const inner = join(root, "inner");
  await initRepository(inner);
  expect(await resolveLocation(inner, exec)).toBe(" inner");
});

test("uses a folder icon outside a repository", async () => {
  expect(await resolveLocation(directory, exec)).toBe(
    formatDirectory(directory),
  );
});

test("handles linked worktrees and symlinked working directories", async () => {
  const root = join(directory, "repo");
  await initRepository(root);
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Initial",
    ],
    { cwd: root },
  );
  const worktree = join(directory, "checkout");
  await exec("git", ["worktree", "add", "-b", "linked", worktree], {
    cwd: root,
  });
  await mkdir(join(worktree, "src"));
  expect(await resolveLocation(join(worktree, "src"), exec)).toBe(
    " checkout/src",
  );

  const alias = join(directory, "alias");
  await symlink(worktree, alias);
  expect(await resolveLocation(join(alias, "src"), exec)).toBe(
    " checkout/src",
  );
});

test.each([
  { code: 128, killed: false, stdout: "" },
  { code: 0, killed: true, stdout: "/partial\n" },
  { code: 0, killed: false, stdout: "" },
])("falls back when the Git probe fails: %j", async (result) => {
  const probe = vi
    .fn<ExtensionAPI["exec"]>()
    .mockResolvedValue({ ...result, stderr: "" });
  expect(await resolveLocation(directory, probe)).toBe(
    formatDirectory(directory),
  );
  expect(probe).toHaveBeenCalledExactlyOnceWith(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: directory, timeout: 1_000 },
  );
});

test("falls back if Git is unavailable", async () => {
  const probe = vi
    .fn<ExtensionAPI["exec"]>()
    .mockRejectedValue(new Error("ENOENT"));
  expect(await resolveLocation(directory, probe)).toBe(
    formatDirectory(directory),
  );
});
