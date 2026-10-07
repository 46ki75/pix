import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const { packageDir, host } = vi.hoisted(() => ({
  packageDir: vi.fn(),
  host: { version: "1.0.1" },
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...original,
    get VERSION() {
      return host.version;
    },
    getPackageDir: packageDir.mockImplementation(original.getPackageDir),
  };
});
import { loadServers } from "./native.ts";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

test.each(["1.0.0", "1.0.2", "1.1.0"])(
  "accepts verified host %s through the version gate",
  async (version) => {
    host.version = version;
    const directory = await mkdtemp(join(tmpdir(), "pix-native-compat-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", directory);
    try {
      await expect(
        loadServers({ cwd: directory, isProjectTrusted: () => false }, []),
      ).resolves.toMatchObject({ servers: [], errors: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each(["0.99.2", "1.0.1", "1.0.3", "1.1.1"])(
  "rejects unverified host %s before reading configuration or importing internals",
  async (version) => {
    host.version = version;
    await expect(
      loadServers({ cwd: "/unused", isProjectTrusted: () => false }, []),
    ).rejects.toThrow(
      `expected @earendil-works/pi-coding-agent 1.0.0 or 1.0.2 or 1.1.0, found ${version}`,
    );
    expect(packageDir).not.toHaveBeenCalled();
  },
);
