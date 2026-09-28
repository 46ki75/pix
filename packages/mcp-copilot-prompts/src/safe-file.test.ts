import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readContainedFile } from "./safe-file.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mcp-copilot-safe-file-"));
  temporaryDirectories.push(path);
  return realpath(path);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("readContainedFile", () => {
  it("reads through an in-root symlink from a validated descriptor", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    await writeFile(target, "inside");
    await symlink(target, link);

    const file = await readContainedFile(link, root, 64);

    expect(file.contents.toString()).toBe("inside");
    expect(file.path).toBe(target);
  });

  it("rejects escaping symlinks and reads no more than the limit", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const target = join(outside, "outside.txt");
    await writeFile(target, "outside");
    await symlink(target, join(root, "link.txt"));

    await expect(
      readContainedFile(join(root, "link.txt"), root, 64),
    ).rejects.toMatchObject({ reason: "outside" });

    const large = join(root, "large.txt");
    await writeFile(large, "12345");
    await expect(readContainedFile(large, root, 4)).rejects.toMatchObject({
      reason: "too-large",
    });
  });
});
