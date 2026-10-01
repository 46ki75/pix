import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "pix-mcp-prompt",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
