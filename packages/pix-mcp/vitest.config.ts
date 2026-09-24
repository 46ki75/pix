import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "pix-mcp",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
