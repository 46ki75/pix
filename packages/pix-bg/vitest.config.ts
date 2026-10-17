import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "pix-bg",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Keep POSIX regressions intact. Windows runs its native backend/ACL suites
    // and the shared extension integration suite instead of POSIX-specific tests.
    exclude:
      process.platform === "win32"
        ? [
            "src/posix-execution.test.ts",
            "src/registry-lifecycle.test.ts",
            "src/registry.test.ts",
            "src/directory.test.ts",
          ]
        : [],
    testTimeout: process.platform === "win32" ? 60_000 : 5000,
    hookTimeout: process.platform === "win32" ? 60_000 : 10_000,
  },
});
