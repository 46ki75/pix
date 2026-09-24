import {
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { privateDirectory } from "./directory.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync) };
});

const directories: string[] = [];
afterEach(() => {
  vi.mocked(lstatSync).mockReset();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "pix-bg-directory-"));
  directories.push(path);
  return path;
}

test("creates and reuses private directories without changing their contents", () => {
  const path = join(root(), "logs");
  expect(privateDirectory(path)).toBe(path);
  writeFileSync(join(path, "retained.log"), "retained");
  expect(privateDirectory(path)).toBe(path);
  expect(statSync(join(path, "retained.log")).size).toBe(8);
  expect(statSync(path).mode & 0o777).toBe(0o700);
});

test("rejects a foreign-owned directory even with private permissions", () => {
  const path = root();
  const info = lstatSync(path);
  // Simulate another UID without requiring privileged multi-user test execution.
  vi.mocked(lstatSync).mockReturnValueOnce(
    Object.assign(info, { uid: info.uid + 1 }),
  );
  expect(() => privateDirectory(path)).toThrow(
    "Unsafe background output directory",
  );
  expect(statSync(path).uid).toBe(process.geteuid?.());
});

test("rejects a regular file instead of repairing it", () => {
  const path = join(root(), "logs");
  writeFileSync(path, "retained", { mode: 0o600 });
  expect(() => privateDirectory(path)).toThrow(
    "Unsafe background output directory",
  );
  expect(statSync(path).size).toBe(8);
});
