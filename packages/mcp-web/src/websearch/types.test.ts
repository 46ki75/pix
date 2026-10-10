import { expect, test } from "vitest";
import { PROVIDER_IDS, selectionFromEnv } from "./types.ts";

test.each([
  [undefined, "auto"],
  ["", "auto"],
  [" \t ", "auto"],
  [" auto ", "auto"],
  ["none", "none"],
  [" none ", "none"],
  ["tavily", "tavily"],
  [" exa , tavily ", ["exa", "tavily"]],
  ["tinyfish,parallel", ["tinyfish", "parallel"]],
  ["exa,tavily,exa", ["exa", "tavily"]],
  ["tavily,tavily", "tavily"],
  [PROVIDER_IDS.join(","), [...PROVIDER_IDS]],
] as const)("parses provider selection %j", (value, expected) => {
  expect(
    selectionFromEnv(
      value === undefined ? {} : { PIX_WEBSEARCH_PROVIDER: value },
    ),
  ).toEqual(expected);
});

test.each([
  "unknown",
  "EXA",
  "exa,unknown-secret",
  "auto,exa",
  "none,exa",
  "auto,none",
  ",exa",
  "exa,",
  "exa,,tavily",
  ",",
])("rejects malformed selection %j", (value) => {
  let error: unknown;
  try {
    selectionFromEnv({ PIX_WEBSEARCH_PROVIDER: value });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error))
    throw new Error("Expected selection validation to fail");
  expect(error.message).toMatch(/^PIX_WEBSEARCH_PROVIDER must be/);
  if (value.includes("secret")) expect(error.message).not.toContain("secret");
});
