import { describe, expect, it } from "vitest";
import { MAX_DESCRIPTION_BYTES, MAX_PROMPT_FILE_BYTES } from "./limits.js";
import { parsePromptFile, PromptParseError } from "./parser.js";

const sourcePath = "/repo/.github/prompts/review.prompt.md";
const rootPath = "/repo";
const variable = (expression: string): string =>
  ["$", "{", expression, "}"].join("");

describe("parsePromptFile", () => {
  it("uses the filename and body when frontmatter is absent", () => {
    const prompt = parsePromptFile("Review this change.", sourcePath, rootPath);

    expect(prompt).toMatchObject({
      name: "review",
      body: "Review this change.",
      inputs: [],
      metadata: {},
    });
  });

  it("does not treat a lone Markdown rule as frontmatter", () => {
    const prompt = parsePromptFile("---", sourcePath, rootPath);

    expect(prompt.body).toBe("---");
  });

  it("parses documented frontmatter and input variables", () => {
    const prompt = parsePromptFile(
      [
        "\uFEFF---\r",
        "name: secure-review\r",
        "description: Review an API\r",
        "argument-hint: API name\r",
        "agent: agent\r",
        "model: Claude Sonnet 4\r",
        "tools: [search/codebase, test]\r",
        "---\r",
        `Review ${variable("input:api:API name")} in ${variable("workspaceFolder")}.\r`,
        `Repeat ${variable("input:api")}.\r`,
        "",
      ].join("\n"),
      sourcePath,
      rootPath,
    );

    expect(prompt).toMatchObject({
      name: "secure-review",
      description: "Review an API",
      inputs: [{ name: "api", placeholder: "API name" }],
      metadata: {
        argumentHint: "API name",
        agent: "agent",
        model: "Claude Sonnet 4",
        tools: ["search/codebase", "test"],
      },
    });
    expect(prompt.body).toBe(
      `Review ${variable("input:api:API name")} in ${variable("workspaceFolder")}.\r\nRepeat ${variable("input:api")}.\r\n`,
    );
  });

  it("ignores unknown frontmatter for forward compatibility", () => {
    const prompt = parsePromptFile(
      "---\nfuture-field: true\n---\nBody",
      sourcePath,
      rootPath,
    );

    expect(prompt.name).toBe("review");
  });

  it.each([
    ["missing delimiter", "---\nname: review\nBody", "closing ---"],
    ["duplicate field", "---\nname: one\nname: two\n---\nBody", "invalid YAML"],
    ["invalid known type", "---\ntools: test\n---\nBody", "tools must"],
    ["empty name", "---\nname: ''\n---\nBody", "must not be empty"],
    [
      "conflicting placeholders",
      `${variable("input:target:first")} ${variable("input:target:second")}`,
      "conflicting placeholders",
    ],
  ])("rejects %s", (_label, source, message) => {
    expect(() => parsePromptFile(source, sourcePath, rootPath)).toThrow(
      new RegExp(message),
    );
  });

  it("rejects oversized input placeholders", () => {
    const source = variable(
      `input:target:${"x".repeat(MAX_DESCRIPTION_BYTES + 1)}`,
    );

    expect(() => parsePromptFile(source, sourcePath, rootPath)).toThrow(
      "invalid placeholder",
    );
  });

  it("rejects oversized source before parsing", () => {
    expect(() =>
      parsePromptFile(
        "x".repeat(MAX_PROMPT_FILE_BYTES + 1),
        sourcePath,
        rootPath,
      ),
    ).toThrow(PromptParseError);
  });
});
