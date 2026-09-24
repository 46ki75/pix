import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ARTIFACT_RETENTION_MS, createArtifactStore } from "./artifacts.ts";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pix-webfetch-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("concurrent writes retain complete content at unique paths", async () => {
  const store = createArtifactStore({ directory });
  const contents = ["# Title\n\n日本語 🌐", "Second result", "Third result"];
  const paths = await Promise.all(
    contents.map((content) => store.save(content, "md")),
  );
  expect(new Set(paths).size).toBe(contents.length);
  expect(
    await Promise.all(paths.map((path) => readFile(path, "utf8"))),
  ).toEqual(contents);
  expect(paths.every((path) => path.endsWith("/output.md"))).toBe(true);
  expect((await stat(paths[0] ?? "")).mode & 0o777).toBe(0o600);
});

test("cleans expired owned artifacts while retaining recent and unrelated entries", async () => {
  const store = createArtifactStore({ directory });
  const expired = await store.save("Expired", "txt");
  const recent = await store.save("Recent", "txt");
  const unrelated = join(directory, "unrelated");
  await mkdir(unrelated);
  const old = new Date(Date.now() - ARTIFACT_RETENTION_MS - 60_000);
  await utimes(dirname(expired), old, old);
  await utimes(unrelated, old, old);
  await store.save("New", "txt");
  await expect(stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(recent, "utf8")).toBe("Recent");
  expect((await stat(unrelated)).isDirectory()).toBe(true);
});

test("removes partial files when persistence fails", async () => {
  const store = createArtifactStore({
    directory,
    write: async (path) => {
      await writeFile(path, "Partial");
      throw new Error("disk failure");
    },
  });
  await expect(store.save("Full content", "txt")).rejects.toThrow(
    "could not save the full output",
  );
  expect(await readdir(directory)).toEqual([]);
});

test("removes output when canceled during persistence", async () => {
  const controller = new AbortController();
  const store = createArtifactStore({
    directory,
    write: async (path, content) => {
      await writeFile(path, content);
      controller.abort();
    },
  });
  await expect(
    store.save("Content", "txt", controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await readdir(directory)).toEqual([]);
});

test("does not create directories for a pre-aborted request", async () => {
  const store = createArtifactStore({ directory: join(directory, "unused") });
  await expect(
    store.save("Content", "txt", AbortSignal.abort()),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await readdir(directory)).toEqual([]);
});

test("reports an unusable artifact directory", async () => {
  const file = join(directory, "file");
  await writeFile(file, "Existing");
  await expect(
    createArtifactStore({ directory: file }).save("Content", "txt"),
  ).rejects.toThrow("could not save the full output");
  expect(await readFile(file, "utf8")).toBe("Existing");
});
