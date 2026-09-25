import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "pix-theme-elmethis",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
