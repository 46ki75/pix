import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "pix-usage",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
