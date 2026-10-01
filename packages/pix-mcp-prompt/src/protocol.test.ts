import { expect, test } from "vitest";
import {
  MAX_PROMPT_IDENTIFIER_BYTES,
  MAX_PROMPT_MESSAGES,
  MAX_PROMPT_METADATA_BYTES,
  MAX_PROMPTS,
  parseGetPromptResult,
  parseListPromptsResult,
} from "./protocol.ts";

const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=";

test("parses bounded prompt metadata and preserves safe private metadata", () => {
  expect(
    parseListPromptsResult({
      prompts: [
        {
          name: "review",
          title: "Review",
          description: "Review a change",
          arguments: [
            { name: "change", description: "The change", required: true },
          ],
          _meta: { provider: "fixture" },
          icons: [{ src: "https://example.test/untrusted.svg" }],
        },
      ],
      nextCursor: "",
      ignored: "value",
    }),
  ).toEqual({
    prompts: [
      {
        name: "review",
        title: "Review",
        description: "Review a change",
        arguments: [
          { name: "change", description: "The change", required: true },
        ],
        _meta: { provider: "fixture" },
      },
    ],
    nextCursor: "",
  });
});

test.each([
  [{ prompts: [{ name: "safe\u202Espoofed" }] }, "name"],
  [{ prompts: [{ name: "bad\nname" }] }, "name"],
  [
    {
      prompts: [{ name: "same" }, { name: "same" }],
    },
    "duplicate",
  ],
  [
    {
      prompts: [
        { name: "prompt", arguments: [{ name: "same" }, { name: "same" }] },
      ],
    },
    "duplicate",
  ],
  [{ prompts: [{ name: "prompt", _meta: [] }] }, "metadata"],
  [{ prompts: [], nextCursor: 1 }, "cursor"],
] as const)("rejects malformed prompt catalogs (%s)", (value, message) => {
  expect(() => parseListPromptsResult(value)).toThrow(message);
});

test("enforces prompt catalog metadata and count limits", () => {
  expect(() =>
    parseListPromptsResult({
      prompts: [{ name: "x".repeat(MAX_PROMPT_IDENTIFIER_BYTES + 1) }],
    }),
  ).toThrow("name");
  expect(() =>
    parseListPromptsResult({
      prompts: [
        {
          name: "long",
          description: "x".repeat(MAX_PROMPT_METADATA_BYTES + 1),
        },
      ],
    }),
  ).toThrow("description");
  expect(() =>
    parseListPromptsResult({
      prompts: Array.from({ length: MAX_PROMPTS + 1 }, (_, index) => ({
        name: `prompt-${index}`,
      })),
    }),
  ).toThrow("result");
});

test("parses every prompt content block shape", () => {
  const value = {
    description: "Rendered fixture",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Question",
          annotations: { audience: ["user"], priority: 0.5 },
          _meta: { source: "fixture" },
        },
      },
      {
        role: "assistant",
        content: { type: "image", data: tinyPng, mimeType: "image/png" },
      },
      {
        role: "assistant",
        content: { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
      },
      {
        role: "user",
        content: {
          type: "resource_link",
          uri: "fixture://notes",
          name: "Notes",
          title: "Fixture notes",
          description: "Reference",
          mimeType: "text/plain",
          size: 9,
        },
      },
      {
        role: "user",
        content: {
          type: "resource",
          resource: {
            uri: "fixture://text",
            mimeType: "text/plain",
            text: "Embedded text",
            _meta: { revision: 1 },
          },
        },
      },
      {
        role: "user",
        content: {
          type: "resource",
          resource: {
            uri: "fixture://blob",
            mimeType: "application/octet-stream",
            blob: "aGVsbG8=",
          },
        },
      },
    ],
  };

  expect(parseGetPromptResult(value)).toEqual(value);
});

test.each([
  [{}, "messages"],
  [{ messages: {}, ignored: true }, "messages"],
  [
    { messages: [{ role: "system", content: { type: "text", text: "x" } }] },
    "role",
  ],
  [{ messages: [{ role: "user", content: { type: "text" } }] }, "text"],
  [
    {
      messages: [
        {
          role: "user",
          content: { type: "image", data: "!", mimeType: "image/png" },
        },
      ],
    },
    "image",
  ],
  [
    {
      messages: [
        {
          role: "user",
          content: { type: "resource_link", uri: "fixture://x", name: 1 },
        },
      ],
    },
    "name",
  ],
  [
    {
      messages: [
        {
          role: "user",
          content: { type: "resource", resource: { uri: "fixture://x" } },
        },
      ],
    },
    "content",
  ],
  [
    {
      messages: [
        {
          role: "user",
          content: {
            type: "audio",
            data: "aGVsbG8=",
            mimeType: "audio/wav",
            annotations: { priority: 2 },
          },
        },
      ],
    },
    "annotations",
  ],
] as const)("rejects malformed prompts/get results (%s)", (value, message) => {
  expect(() => parseGetPromptResult(value)).toThrow(message);
});

test("bounds prompt message count and serialized result size", () => {
  expect(() =>
    parseGetPromptResult({
      messages: Array.from({ length: MAX_PROMPT_MESSAGES + 1 }, () => ({
        role: "user",
        content: { type: "text", text: "x" },
      })),
    }),
  ).toThrow("messages");
  expect(() =>
    parseGetPromptResult({
      messages: [
        {
          role: "user",
          content: { type: "text", text: "x".repeat(16 * 1024 * 1024) },
        },
      ],
    }),
  ).toThrow("size");
});
