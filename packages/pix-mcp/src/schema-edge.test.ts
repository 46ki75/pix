import { Ajv } from "ajv";
import { Compile } from "typebox/compile";
import { validateToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { prepareSchema, schemaValidator } from "./schema.ts";

const draft07 = "http://json-schema.org/draft-07/schema#";
const reference = new Ajv({
  strict: false,
  validateFormats: false,
  ownProperties: true,
});

function equivalent(
  schema: Record<string, unknown>,
  cases: [JsonObject, boolean][],
) {
  const source = { $schema: draft07, ...schema };
  const { parameters, validator } = prepareSchema(source);
  const expected = reference.compile(source);
  const exposed = Compile(parameters);
  for (const [data, valid] of cases) {
    expect(expected(data), JSON.stringify(data)).toBe(valid);
    expect(validator.Check(data), JSON.stringify(data)).toBe(valid);
    expect(exposed.Check(data), JSON.stringify(data)).toBe(valid);
    const call = () =>
      validateToolCall([{ name: "edge", description: "", parameters }], {
        type: "toolCall",
        id: "edge",
        name: "edge",
        arguments: data,
      });
    if (valid) expect(call()).toEqual(data);
    else expect(call).toThrow("Validation failed");
  }
  return parameters;
}

test.each(["e\u0301", "🇺🇸", "👩‍👩‍👧", "a\ufe0f"])(
  "length bounds count code points, not grapheme clusters (%s)",
  (text) => {
    const length = Array.from(text).length;
    for (const bound of [{ maxLength: length - 1 }, { minLength: length }]) {
      const parameters = equivalent(
        {
          type: "object",
          properties: { text: { type: "string", ...bound } },
          required: ["text"],
        },
        [[{ text }, "minLength" in bound]],
      );
      expect(parameters).not.toHaveProperty("properties.text.minLength");
      expect(parameters).not.toHaveProperty("properties.text.maxLength");
    }
  },
);

test("length normalization intersects existing patterns and applicators", () => {
  equivalent(
    {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 2,
          maxLength: 3,
          pattern: "^e",
          allOf: [{ not: { const: "ee" } }],
        },
      },
      required: ["text"],
    },
    [
      [{ text: "e\u0301" }, true],
      [{ text: "e\n" }, true],
      [{ text: "e😀" }, true],
      [{ text: "e" }, false],
      [{ text: "abcd" }, false],
      [{ text: "a\u0301" }, false],
      [{ text: "ee" }, false],
    ],
  );
});

test("contradictory and zero length bounds retain their non-string behavior", () => {
  for (const [bounds, validText] of [
    [{ minLength: 2, maxLength: 1 }, false],
    [{ maxLength: 0 }, true],
  ] as const) {
    equivalent(
      { type: "object", properties: { value: bounds }, required: ["value"] },
      [
        [{ value: "" }, validText],
        [{ value: "a" }, false],
        [{ value: null }, true],
        [{ value: 1 }, true],
      ],
    );
  }
});

test("unsafe length quantifiers are rejected instead of becoming literal regex text", () => {
  for (const bounds of [{ minLength: 1e21 }, { maxLength: 1e21 }]) {
    expect(() =>
      prepareSchema({ $schema: draft07, properties: { text: bounds } }),
    ).toThrow(expect.objectContaining({ code: "draft07-length" }));
  }
});

test("equal property counts do not substitute for matching required key sets", () => {
  equivalent(
    {
      type: "object",
      properties: { a: {} },
      required: ["b"],
      additionalProperties: false,
    },
    [
      [{}, false],
      [{ a: 1 }, false],
      [{ b: 1 }, false],
      [{ a: 1, b: 1 }, false],
    ],
  );
  equivalent(
    {
      type: "object",
      properties: { a: {} },
      required: ["a"],
      additionalProperties: false,
    },
    [
      [{ a: 1 }, true],
      [{ b: 1 }, false],
      [{ a: 1, b: 1 }, false],
    ],
  );
  equivalent(
    {
      type: "object",
      properties: { a: {} },
      patternProperties: { "^b$": {} },
      required: ["b"],
      additionalProperties: false,
    },
    [
      [{ b: 1 }, true],
      [{ a: 1, b: 1 }, true],
      [{ c: 1 }, false],
    ],
  );
});

test("property names containing line breaks remain distinct", () => {
  // By design, TypeBox's non-multiline JavaScript anchors match the exact key:
  // unlike some regex engines, /^x$/u does not match a trailing newline.
  const cases: [JsonObject, boolean][] = [[{ x: 1 }, true]];
  for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"])
    cases.push([{ [`x${suffix}`]: 1 }, false]);
  equivalent(
    { type: "object", properties: { x: {} }, additionalProperties: false },
    cases,
  );
});

test.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
  "rejects prototype-sensitive property constraints (%s)",
  (name) => {
    for (const fragment of [
      { required: [name] },
      { properties: { [name]: { type: "string" } } },
    ]) {
      expect(() =>
        prepareSchema({ $schema: draft07, type: "object", ...fragment }),
      ).toThrow(expect.objectContaining({ code: "draft07-property-name" }));
    }
  },
);

test("uniqueItems:true fails closed rather than using lossy structural hashes", () => {
  const schema = {
    $schema: draft07,
    type: "object",
    properties: { values: { type: "array", uniqueItems: true } },
  };
  expect(reference.compile(schema)({ values: [[[], []], [[[]]]] })).toBe(true);
  expect(() => prepareSchema(schema)).toThrow(
    expect.objectContaining({ code: "draft07-unique-items" }),
  );
  equivalent(
    {
      type: "object",
      properties: { values: { type: "array", uniqueItems: false } },
    },
    [
      [{ values: [[[], []], [[[]]]] }, true],
      [{ values: [1, 1] }, true],
    ],
  );
});

test.each([
  { const: [] },
  { enum: [[]] },
  { const: { inner: [] } },
  { enum: [1, { inner: [] }] },
])(
  "array-containing literals fail closed for input and output (%j)",
  (fragment) => {
    const schema = {
      $schema: draft07,
      type: "object",
      properties: { value: fragment },
      required: ["value"],
    };
    const data =
      "const" in fragment && fragment.const && !Array.isArray(fragment.const)
        ? { value: { inner: { length: 0 } } }
        : { value: { length: 0 } };
    expect(reference.compile(schema)(data)).toBe(false);
    for (const compile of [prepareSchema, schemaValidator.getValidator])
      expect(() => compile(schema)).toThrow(
        expect.objectContaining({ code: "draft07-literal-array" }),
      );
  },
);

test("patternProperties numeric backreferences fail closed before capture indices can change", () => {
  const schema = {
    $schema: draft07,
    type: "object",
    patternProperties: { "^(a)\\1$": true },
    additionalProperties: false,
  };
  const expected = reference.compile(schema);
  expect(expected({ aa: 1 })).toBe(true);
  expect(expected({ a: 1 })).toBe(false);
  for (const compile of [prepareSchema, schemaValidator.getValidator])
    expect(() => compile(schema)).toThrow(
      expect.objectContaining({ code: "draft07-pattern-backreference" }),
    );
  // Deliberately gate the pattern syntax even without additionalProperties,
  // rather than making the supported subset depend on compiler branch selection.
  expect(() =>
    prepareSchema({ ...schema, additionalProperties: true }),
  ).toThrow(expect.objectContaining({ code: "draft07-pattern-backreference" }));
});

test("patternProperties preserves escaped backslashes and named references", () => {
  equivalent(
    {
      type: "object",
      patternProperties: { "^\\\\1$": true },
      additionalProperties: false,
    },
    [
      [{ "\\1": 1 }, true],
      [{ a: 1 }, false],
    ],
  );
  equivalent(
    {
      type: "object",
      patternProperties: { "^(?<letter>a)\\k<letter>$": true },
      additionalProperties: false,
    },
    [
      [{ aa: 1 }, true],
      [{ a: 1 }, false],
    ],
  );
});

test("multipleOf fails closed rather than accepting small nonmultiples", () => {
  const schema = {
    $schema: draft07,
    type: "object",
    properties: { n: { type: "number", multipleOf: 2 } },
  };
  expect(reference.compile(schema)({ n: 1e-12 })).toBe(false);
  expect(() => prepareSchema(schema)).toThrow(
    expect.objectContaining({ code: "draft07-multiple-of" }),
  );
});
