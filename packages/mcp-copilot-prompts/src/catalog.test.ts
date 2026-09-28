import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptCatalog } from "./catalog.js";
import { canonicalizeRoot } from "./roots.js";

const temporaryDirectories: string[] = [];
const catalogs: PromptCatalog[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mcp-copilot-catalog-"));
  temporaryDirectories.push(path);
  return realpath(path);
}

afterEach(async () => {
  await Promise.all(catalogs.splice(0).map((catalog) => catalog.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("PromptCatalog", () => {
  it("runs a follow-up pass when refresh is requested during discovery", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, ".github", "prompts");
    await mkdir(directory, { recursive: true });
    let requestFollowUp = false;
    const catalog = new PromptCatalog({
      watch: false,
      onChanged: async () => {
        if (!requestFollowUp) return;
        requestFollowUp = false;
        await writeFile(join(directory, "second.prompt.md"), "Second");
        void catalog.refresh();
      },
    });
    catalogs.push(catalog);
    await catalog.setRoots([await canonicalizeRoot({ path: root })]);
    await writeFile(join(directory, "first.prompt.md"), "First");
    requestFollowUp = true;

    await catalog.refresh();

    expect(
      catalog.snapshot().prompts.map((entry) => entry.exposedName),
    ).toEqual(["first", "second"]);
  });

  it("coalesces concurrent ordinary refreshes", async () => {
    const root = await temporaryDirectory();
    const catalog = new PromptCatalog({ watch: false });
    catalogs.push(catalog);
    await catalog.setRoots([await canonicalizeRoot({ path: root })]);

    const first = catalog.refresh();
    const second = catalog.refresh();

    expect(second).toBe(first);
    await first;
  });

  it("updates watcher topology without changing the catalog generation", async () => {
    const root = await temporaryDirectory();
    const target = join(root, "shared-prompts");
    await mkdir(join(root, ".github"), { recursive: true });
    await mkdir(target);
    const catalog = new PromptCatalog();
    catalogs.push(catalog);
    await catalog.setRoots([await canonicalizeRoot({ path: root })]);
    const generation = catalog.snapshot().generation;
    await symlink(target, join(root, ".github", "prompts"));

    expect(await catalog.refresh()).toBe(false);
    expect(catalog.snapshot().generation).toBe(generation);
    await writeFile(join(target, "new.prompt.md"), "New");
    await vi.waitFor(
      () =>
        expect(
          catalog.snapshot().prompts.map((entry) => entry.exposedName),
        ).toEqual(["new"]),
      { timeout: 3_000 },
    );
  });

  it("updates diagnostics without changing the catalog generation", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, ".github", "prompts");
    const malformed = join(directory, "bad.prompt.md");
    await mkdir(directory, { recursive: true });
    await writeFile(malformed, "---\nname: [\n---\nBad");
    const catalog = new PromptCatalog({ watch: false });
    catalogs.push(catalog);
    await catalog.setRoots([await canonicalizeRoot({ path: root })]);
    const generation = catalog.snapshot().generation;
    expect(catalog.snapshot().diagnostics).toHaveLength(1);

    await unlink(malformed);
    const changed = await catalog.refresh();

    expect(changed).toBe(false);
    expect(catalog.snapshot().generation).toBe(generation);
    expect(catalog.snapshot().diagnostics).toEqual([]);
  });
});
