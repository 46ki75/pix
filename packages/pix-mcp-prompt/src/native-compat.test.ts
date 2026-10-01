import { expect, test, vi } from "vitest";

const packageDir = vi.hoisted(() => vi.fn());
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  VERSION: "0.100.0",
  getPackageDir: packageDir,
}));
import { loadServers } from "./native.ts";

test("rejects an unverified host before reading configuration or importing internals", async () => {
  await expect(
    loadServers({ cwd: "/unused", isProjectTrusted: () => false }, []),
  ).rejects.toThrow(
    "expected @earendil-works/pi-coding-agent 0.99.2, found 0.100.0",
  );
  expect(packageDir).not.toHaveBeenCalled();
});
