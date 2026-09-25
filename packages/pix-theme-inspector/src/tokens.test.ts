import { expect, test } from "vitest";
import { TOKENS } from "./tokens.ts";

test("catalog covers Pi 0.87.1's 49 foreground and 7 background tokens exactly once", () => {
  expect(TOKENS).toHaveLength(56);
  expect(new Set(TOKENS.map((token) => token.name)).size).toBe(56);
  expect(TOKENS.filter((token) => token.kind === "foreground")).toHaveLength(
    49,
  );
  expect(
    TOKENS.filter((token) => token.kind === "background").map(
      (token) => token.name,
    ),
  ).toEqual([
    "selectedBg",
    "searchMatchBg",
    "userMessageBg",
    "customMessageBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
  ]);
});

test("every token has a short, single-line description", () => {
  for (const token of TOKENS) {
    expect(token.description).toEqual(expect.any(String));
    expect(token.description.trim()).toBe(token.description);
    expect(token.description.length).toBeGreaterThan(0);
    expect(token.description.length).toBeLessThanOrEqual(64);
    expect(token.description).not.toContain("\n");
  }
});

test("groups remain contiguous and distinguish foreground from background roles", () => {
  const counts = new Map<string, number>();
  let previous = "";
  for (const token of TOKENS) {
    const key = `${token.kind}/${token.group}`;
    if (key !== previous) expect(counts.has(key)).toBe(false);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    previous = key;
  }
  expect(Object.fromEntries(counts)).toEqual({
    "foreground/General": 4,
    "foreground/Borders": 3,
    "foreground/Status": 3,
    "foreground/Scrollbars/search": 3,
    "foreground/Messages": 4,
    "foreground/Tools": 2,
    "foreground/Markdown": 10,
    "foreground/Diffs": 3,
    "foreground/Syntax": 9,
    "foreground/Thinking-level borders": 7,
    "foreground/Bash-mode border": 1,
    "background/Selection/search": 2,
    "background/Messages": 2,
    "background/Tool states": 3,
  });
});
