import { expect, test, vi } from "vitest";

const { packageDir, host } = vi.hoisted(() => ({
  packageDir: vi.fn(),
  host: { version: "1.0.1" },
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  get VERSION() {
    return host.version;
  },
  getPackageDir: packageDir,
}));
import { loadServers } from "./native.ts";

test.each(["0.99.2", "1.0.1", "1.1.0"])(
  "rejects unverified host %s before reading configuration or importing internals",
  async (version) => {
    host.version = version;
    await expect(
      loadServers({ cwd: "/unused", isProjectTrusted: () => false }, []),
    ).rejects.toThrow(
      `expected @earendil-works/pi-coding-agent 1.0.0, found ${version}`,
    );
    expect(packageDir).not.toHaveBeenCalled();
  },
);
