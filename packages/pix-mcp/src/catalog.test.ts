import { expect, test } from "vitest";
import { entry, search, toolName } from "./catalog.ts";

const make = (server: string, name: string, description: string) =>
  entry(server, { name, description, inputSchema: { type: "object" } });

test("tool aliases are stable, bounded and collision-safe across servers and normalization", () => {
  const names = [
    toolName("a", "x.y"),
    toolName("a", "x-y"),
    toolName("b", "x.y"),
    toolName("a", "x_y"),
    toolName("long".repeat(12), "tool".repeat(100)),
  ];
  expect(new Set(names).size).toBe(names.length);
  expect(names.every((name) => /^[A-Za-z0-9_]{1,64}$/.test(name))).toBe(true);
  expect(toolName("a", "x.y")).toBe(names[0]);
});

test("search ranks names before descriptions, is deterministic and supports a server filter", () => {
  const entries = [
    make("docs", "read", "Search issue descriptions"),
    make("github", "issues", "Find tickets"),
    make("other", "issues", "Find tickets"),
  ];
  expect(search(entries, "issues").map((item) => item.server)).toEqual([
    "github",
    "other",
  ]);
  expect(search(entries, "issue")[2]?.server).toBe("docs");
  expect(search(entries, "tickets", "github")).toEqual([entries[1]]);
  expect(search(entries, "[.*]")).toEqual([]);
  expect(search(entries, "nonexistent")).toEqual([]);
  expect(search(entries, "ISSUES")).toEqual(
    search([...entries].reverse(), "issues"),
  );
});
