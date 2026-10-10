import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FetchError } from "./fetch.ts";

export const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type SaveArtifact = (
  content: string,
  extension: "md" | "txt",
  signal?: AbortSignal,
) => Promise<string>;

interface ArtifactOptions {
  directory?: string;
  write?: (
    path: string,
    content: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export function createArtifactStore(options: ArtifactOptions = {}): {
  save: SaveArtifact;
} {
  const directory = options.directory ?? join(tmpdir(), "pix-webfetch");
  const write =
    options.write ??
    (async (path, content, signal) => {
      await writeFile(path, content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
        signal,
      });
    });

  async function cleanup() {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    const cutoff = Date.now() - ARTIFACT_RETENTION_MS;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^fetch-[A-Za-z0-9]{6}$/.test(entry.name))
        continue;
      const path = join(directory, entry.name);
      try {
        if ((await stat(path)).mtimeMs < cutoff)
          await rm(path, { recursive: true, force: true });
      } catch {
        // Another process or the OS may have removed a temporary artifact already.
      }
    }
  }

  return {
    async save(content, extension, signal) {
      signal?.throwIfAborted();
      let artifactDirectory: string | undefined;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await cleanup();
        signal?.throwIfAborted();
        artifactDirectory = await mkdtemp(join(directory, "fetch-"));
        const path = join(artifactDirectory, `output.${extension}`);
        await write(path, content, signal);
        signal?.throwIfAborted();
        return path;
      } catch {
        if (artifactDirectory)
          await rm(artifactDirectory, { recursive: true, force: true }).catch(
            () => {},
          );
        if (signal?.aborted) throw signal.reason;
        throw new FetchError("Web fetch could not save the full output.");
      }
    },
  };
}
