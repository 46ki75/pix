import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "pix-bg",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
