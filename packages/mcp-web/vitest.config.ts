import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "mcp-web",
    environment: "node",
    include: ["src/**/*.test.ts"],
    hookTimeout: 30_000,
  },
});
