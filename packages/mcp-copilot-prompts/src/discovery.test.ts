import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPrompts } from "./discovery.js";
import { MAX_NAME_BYTES } from "./limits.js";
import { canonicalizeRoot } from "./roots.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mcp-copilot-prompts-"));
  temporaryDirectories.push(path);
  return path;
}

async function writePrompt(
  root: string,
  name: string,
  source: string | Uint8Array,
): Promise<string> {
  const directory = join(root, ".github", "prompts");
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, source);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("discoverPrompts", () => {
  it("discovers direct prompt files in deterministic order", async () => {
    const path = await temporaryDirectory();
    await writePrompt(path, "z.prompt.md", "Z");
    await writePrompt(path, "a.prompt.md", "A");
    await writePrompt(path, "ignored.md", "ignored");
    await mkdir(join(path, ".github", "prompts", "nested"));
    await writeFile(
      join(path, ".github", "prompts", "nested", "nested.prompt.md"),
      "nested",
    );

    const result = await discoverPrompts([await canonicalizeRoot({ path })]);

    expect(result.prompts.map((entry) => entry.exposedName)).toEqual([
      "a",
      "z",
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("isolates malformed files and reports bounded diagnostics", async () => {
    const path = await temporaryDirectory();
    await writePrompt(path, "good.prompt.md", "Good");
    await writePrompt(path, "bad.prompt.md", "---\nname: [\n---\nBad");
    await writePrompt(path, "binary.prompt.md", Uint8Array.from([0xff, 0xfe]));

    const result = await discoverPrompts([await canonicalizeRoot({ path })]);

    expect(result.prompts.map((entry) => entry.exposedName)).toEqual(["good"]);
    expect(result.diagnostics.map((item) => item.path)).toEqual([
      ".github/prompts/bad.prompt.md",
      ".github/prompts/binary.prompt.md",
    ]);
  });

  it("omits every file with a duplicate name in one root", async () => {
    const path = await temporaryDirectory();
    await writePrompt(path, "one.prompt.md", "---\nname: same\n---\nOne");
    await writePrompt(path, "two.prompt.md", "---\nname: same\n---\nTwo");

    const result = await discoverPrompts([await canonicalizeRoot({ path })]);

    expect(result.prompts).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain(
      "duplicate Copilot prompt name",
    );
  });

  it("namespaces cross-root name collisions", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    await writePrompt(first, "review.prompt.md", "First");
    await writePrompt(second, "review.prompt.md", "Second");
    const roots = await Promise.all([
      canonicalizeRoot({ path: first, label: "frontend" }),
      canonicalizeRoot({ path: second, label: "backend" }),
    ]);

    const result = await discoverPrompts(roots);

    expect(result.prompts.map((entry) => entry.exposedName)).toEqual([
      "backend/review",
      "frontend/review",
    ]);
  });

  it("bounds namespaced prompt names", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    const name = "n".repeat(250);
    await writePrompt(first, "one.prompt.md", `---\nname: ${name}\n---\nOne`);
    await writePrompt(second, "two.prompt.md", `---\nname: ${name}\n---\nTwo`);
    const roots = await Promise.all([
      canonicalizeRoot({ path: first, label: "a".repeat(250) }),
      canonicalizeRoot({ path: second, label: "b".repeat(250) }),
    ]);

    const result = await discoverPrompts(roots);

    expect(result.prompts).toHaveLength(2);
    expect(
      result.prompts.every(
        (entry) => Buffer.byteLength(entry.exposedName) <= MAX_NAME_BYTES,
      ),
    ).toBe(true);
    expect(new Set(result.prompts.map((entry) => entry.exposedName)).size).toBe(
      2,
    );
  });

  it("does not watch dangling symlinks reached through an escaping ancestor", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink("future", join(outside, "prompts"));
    await symlink(outside, join(root, ".github"));

    const result = await discoverPrompts([
      await canonicalizeRoot({ path: root }),
    ]);

    expect(result.prompts).toEqual([]);
    expect(result.watchDirectories).toEqual([]);
    expect(result.watchFiles).toEqual([]);
  });

  it("rejects prompt symlinks that escape the root", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const target = join(outside, "outside.prompt.md");
    await writeFile(target, "Outside");
    const directory = join(root, ".github", "prompts");
    await mkdir(directory, { recursive: true });
    await symlink(target, join(directory, "outside.prompt.md"));

    const result = await discoverPrompts([
      await canonicalizeRoot({ path: root }),
    ]);

    expect(result.prompts).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain(
      "outside the configured root",
    );
  });
});
