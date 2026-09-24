import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "pix-webfetch",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
