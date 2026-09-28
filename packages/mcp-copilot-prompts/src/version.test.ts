import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION } from "./server.js";

describe("server version", () => {
  it("matches the package version", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };

    expect(SERVER_VERSION).toBe(packageJson.version);
  });
});
