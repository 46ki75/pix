import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test } from "vitest";
import { tinyPng } from "./fixtures/server.ts";
import {
  formatPromptList,
  formatPromptResult,
  parsePromptCommand,
  promptCompletions,
  resolvePromptArguments,
  type PromptEntry,
} from "./prompts.ts";

const review: PromptEntry = {
  server: "fixture",
  prompt: {
    name: "code review",
    description: "Review code",
    arguments: [{ name: "code", required: true }, { name: "tone" }],
  },
};

test("parses list and run commands with shell-style quoted arguments", () => {
  expect(parsePromptCommand("list fixture")).toEqual({
    action: "list",
    server: "fixture",
  });
  expect(
    parsePromptCommand(
      'run fixture "code review" "const answer = 42" tone=brief',
    ),
  ).toEqual({
    action: "run",
    server: "fixture",
    name: "code review",
    argumentTokens: [
      { value: "const answer = 42" },
      { value: "tone=brief", separator: 4 },
    ],
  });
  expect(() => parsePromptCommand('run fixture "unterminated')).toThrow(
    "Unterminated",
  );
});

test("resolves positional and named prompt arguments without prototype hazards", () => {
  expect(
    resolvePromptArguments(review.prompt, [
      "tone=concise",
      "const answer = 42",
    ]),
  ).toEqual({ code: "const answer = 42", tone: "concise" });
  expect(resolvePromptArguments(review.prompt, ["x=1"])).toEqual({
    code: "x=1",
  });
  const prototypeArgument = resolvePromptArguments(
    {
      name: "prototype",
      arguments: [{ name: "__proto__", required: true }],
    },
    ["__proto__=safe"],
  );
  expect(Object.hasOwn(prototypeArgument ?? {}, "__proto__")).toBe(true);
  expect(prototypeArgument?.__proto__).toBe("safe");
  expect(resolvePromptArguments(review.prompt, ["code="])).toEqual({
    code: "",
  });
  expect(resolvePromptArguments(review.prompt, [""])).toEqual({ code: "" });
  expect(() => resolvePromptArguments(review.prompt, [])).toThrow(
    "Missing required prompt arguments: code",
  );
  expect(() => resolvePromptArguments(review.prompt, ["a", "b", "c"])).toThrow(
    "Too many positional",
  );
  expect(() =>
    resolvePromptArguments(review.prompt, ["code=a", "code=b"]),
  ).toThrow("more than once");
});

test("lists prompts compactly and completes actions, servers, and names", () => {
  expect(formatPromptList([review])).toContain(
    'fixture "code review" <code> [tone] — Review code',
  );
  expect(promptCompletions("", [review])?.map((item) => item.value)).toEqual([
    "list",
    "run",
  ]);
  expect(promptCompletions("run fi", [review])).toContainEqual({
    value: "run fixture",
    label: "fixture",
  });
  expect(promptCompletions("run fixture c", [review])).toContainEqual({
    value: 'run fixture "code review"',
    label: "code review",
    description: "Review code",
  });
  expect(promptCompletions('run fixture "code review" t', [review])).toEqual([
    { value: 'run fixture "code review" tone=', label: "tone=" },
  ]);
  expect(
    promptCompletions('run fixture "code review" "const x=1" ', [review]),
  ).toEqual([
    {
      value: 'run fixture "code review" "const x=1" tone=',
      label: "tone=",
    },
  ]);
  const equalsArgument: PromptEntry = {
    server: "fixture",
    prompt: {
      name: "equals",
      arguments: [
        { name: "x=y", required: true },
        { name: "a", required: true },
      ],
    },
  };
  expect(
    promptCompletions("run fixture equals ", [equalsArgument]),
  ).toContainEqual({ value: 'run fixture equals "x=y"=', label: "x=y=" });
  const escaped = parsePromptCommand('run fixture equals "a=b" "x=y"=assigned');
  if (escaped.action !== "run") throw new Error("Expected run command");
  expect(
    resolvePromptArguments(equalsArgument.prompt, escaped.argumentTokens),
  ).toEqual({ "x=y": "assigned", a: "a=b" });
});

test("formats roles, images, and embedded text resources for Pi", async () => {
  const result = await formatPromptResult({
    messages: [
      { role: "user", content: { type: "text", text: "Question" } },
      {
        role: "assistant",
        content: { type: "image", mimeType: "image/png", data: tinyPng },
      },
      {
        role: "user",
        content: {
          type: "resource",
          resource: { uri: "fixture://notes", text: "Reference" },
        },
      },
    ],
  });
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("[user]\n\nQuestion"),
  });
  expect(result.content[0]).toMatchObject({
    text: expect.stringContaining("[assistant]"),
  });
  expect(result.content[1]).toEqual({
    type: "image",
    mimeType: "image/png",
    data: tinyPng,
  });
  expect(result.content[2]).toMatchObject({
    type: "text",
    text: expect.stringContaining(
      "[MCP embedded resource fixture://notes]\nReference",
    ),
  });
});

test("preserves a single-user image prompt without adding text", async () => {
  const result = await formatPromptResult({
    messages: [
      {
        role: "user",
        content: { type: "image", mimeType: "image/png", data: tinyPng },
      },
    ],
  });

  expect(result.content).toEqual([
    { type: "image", mimeType: "image/png", data: tinyPng },
  ]);
});

test.each([
  [{ role: "user" as const, content: { type: "text" as const, text: "" } }],
  [
    {
      role: "assistant" as const,
      content: { type: "text" as const, text: "" },
    },
  ],
  [
    { role: "user" as const, content: { type: "text" as const, text: "" } },
    {
      role: "assistant" as const,
      content: { type: "text" as const, text: "  " },
    },
  ],
  [
    {
      role: "user" as const,
      content: { type: "image" as const, mimeType: "image/png", data: "" },
    },
  ],
  [
    {
      role: "user" as const,
      content: {
        type: "resource" as const,
        resource: { uri: "fixture://empty", text: "\n" },
      },
    },
  ],
])("rejects a prompt with no usable content", async (...messages) => {
  await expect(formatPromptResult({ messages })).rejects.toThrow(
    "MCP prompt returned no usable content.",
  );
});

test("preserves unsupported prompt content in a private artifact", async () => {
  const result = await formatPromptResult({
    messages: [
      {
        role: "user",
        content: {
          type: "audio",
          mimeType: "audio/wav",
          data: "aGVsbG8=",
        },
      },
    ],
  });
  const path = result.details.fullOutputPath;
  expect(path).toBeDefined();
  if (!path) throw new Error("Missing prompt artifact");
  try {
    const text = result.content[0];
    expect(text).toMatchObject({
      type: "text",
      text: expect.stringContaining("MCP audio content omitted"),
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      messages: [{ content: { type: "audio" } }],
    });
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});
