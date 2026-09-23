import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "hello",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
