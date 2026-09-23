import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverAndLoadExtensions,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";

test("Pi loads the package manifest and can invoke /hello", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pix-hello-"));

  try {
    // Isolate discovery from the developer's project and global Pi extensions.
    const result = await discoverAndLoadExtensions(
      [fileURLToPath(new URL("../", import.meta.url))],
      directory,
      join(directory, "agent"),
    );

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);

    const command = result.extensions[0]?.commands.get("hello");
    expect(command).toBeDefined();
    if (!command) throw new Error("Pi did not register /hello");

    const notify = vi.fn();
    const context = {
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext;

    await command.handler(" Pi ", context);
    expect(notify).toHaveBeenLastCalledWith("Hello, Pi!", "info");

    await command.handler("", context);
    expect(notify).toHaveBeenLastCalledWith("Hello, world!", "info");

    notify.mockClear();
    await command.handler("Pi", { ...context, hasUI: false });
    expect(notify).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
