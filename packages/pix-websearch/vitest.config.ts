import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "pix-websearch",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
