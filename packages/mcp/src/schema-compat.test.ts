import { Ajv } from "ajv";
import { Compile } from "typebox/compile";
import { validateToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { compileSchema, prepareSchema, schemaValidator } from "./schema.ts";
import { ToolRejectionError, type RejectionCode } from "./rejection.ts";
import { legacySchema } from "./fixtures/server.ts";

const draft07 = "http://json-schema.org/draft-07/schema#";
const modern = "https://json-schema.org/draft/2020-12/schema";
// No references or formats in the accepted subset. In particular, Ajv 8's
// default $ref-sibling behavior is NOT a draft-07 conformance oracle.
const reference = new Ajv({ strict: false, validateFormats: false });

function expectRejection(schema: Record<string, unknown>, code: RejectionCode) {
  expect(() => prepareSchema(schema)).toThrowError(
    new ToolRejectionError(code),
  );
  try {
    prepareSchema(schema);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

test.each([
  "http://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema#",
])("normalizes Eagle-style empty input objects (%s)", ($schema) => {
  const schema = {
    $schema,
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  const original = structuredClone(schema);
  const { parameters, validator } = prepareSchema(schema);
  expect(parameters).toEqual({ ...schema, $schema: modern });
  expect(parameters).not.toBe(schema);
  expect(schema).toEqual(original);
  expect(validator.Check({})).toBe(true);
  expect(validator.Check({ extra: true })).toBe(false);
  const native = [{ name: "eagle", description: "", parameters }];
  expect(
    validateToolCall(native, {
      type: "toolCall",
      id: "empty",
      name: "eagle",
      arguments: {},
    }),
  ).toEqual({});
  expect(() =>
    validateToolCall(native, {
      type: "toolCall",
      id: "extra",
      name: "eagle",
      arguments: { extra: true },
    }),
  ).toThrow("Validation failed");
});

const constraints: {
  name: string;
  schema: Record<string, unknown>;
  valid: unknown[];
  invalid: unknown[];
}[] = [
  {
    name: "object constraints",
    schema: {
      type: "object",
      properties: { id: { type: "integer" } },
      patternProperties: { "^x_": { type: "boolean" } },
      required: ["id"],
      propertyNames: { pattern: "^[a-z_]+$" },
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 2,
    },
    valid: [{ id: 1 }, { id: 1, x_a: true }],
    invalid: [
      {},
      { id: 1.5 },
      { id: 1, other: 2 },
      { id: 1, x_a: 1 },
      { id: 1, x_a: true, x_b: false },
      { id: 1, x_1: true },
    ],
  },
  {
    name: "schema-valued additional properties",
    schema: { type: "object", additionalProperties: { type: "integer" } },
    valid: [{}, { x: 1 }],
    invalid: [{ x: "one" }],
  },
  {
    name: "numeric bounds",
    schema: {
      type: "number",
      minimum: 0,
      maximum: 10,
      exclusiveMinimum: 1,
      exclusiveMaximum: 9,
    },
    valid: [1.25, 2, 2.1, 8.75],
    invalid: [0, 1, 9, 10, "2"],
  },
  {
    name: "Unicode lengths and patterns",
    schema: { type: "string", minLength: 2, maxLength: 3, pattern: "^a" },
    valid: ["ab", "abc", "a😀"],
    invalid: ["a", "abcd", "ba", 1],
  },
  {
    name: "homogeneous arrays",
    schema: {
      type: "array",
      items: { type: "integer" },
      minItems: 1,
      maxItems: 3,
      uniqueItems: false,
      contains: { minimum: 2 },
    },
    valid: [[2], [1, 2], [1, 2, 3], [2, 2]],
    invalid: [[], [1], [1, 2, 3, 4], ["2"]],
  },
  {
    name: "booleans and null unions",
    schema: {
      type: "object",
      properties: {
        open: true,
        closed: false,
        nullable: { type: ["string", "null"] },
        flag: { type: "boolean" },
      },
    },
    valid: [
      { open: 1, nullable: null, flag: true },
      { open: {}, nullable: "x", flag: false },
    ],
    invalid: [{ closed: 1 }, { nullable: 1 }, { flag: "true" }],
  },
  {
    name: "enum and const instance equality",
    schema: {
      anyOf: [
        { enum: ["x", 1, { nested: { flag: true, value: null } }] },
        { const: { a: 1, b: 2 } },
      ],
    },
    valid: ["x", 1, { nested: { flag: true, value: null } }, { b: 2, a: 1 }],
    invalid: ["1", {}, { nested: { flag: true } }, { a: 1, b: 2, c: 3 }],
  },
  {
    name: "applicators",
    schema: {
      allOf: [
        { anyOf: [{ type: "integer" }, { type: "string" }] },
        { not: { const: 0 } },
      ],
      oneOf: [
        { type: "number", minimum: 1 },
        { type: "string", minLength: 2 },
      ],
    },
    valid: [1, "ab"],
    invalid: [0, -1, 1.5, "a", true],
  },
  {
    name: "conditionals",
    schema: {
      if: { type: "string" },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema's non-callable conditional keyword.
      then: { minLength: 2 },
      else: { type: "integer", minimum: 1 },
    },
    valid: ["ab", 1],
    invalid: ["a", 0, false],
  },
  {
    name: "constraints without type",
    schema: { minLength: 2, minimum: 1, minItems: 1, minProperties: 1 },
    valid: ["ab", 1, [1], { a: 1 }, null, true],
    invalid: ["a", 0, [], {}],
  },
];

test.each(constraints)(
  "preserves draft-07 $name",
  ({ schema, valid, invalid }) => {
    const source = { $schema: draft07, ...schema };
    const original = structuredClone(source);
    const { parameters, validator } = prepareSchema(source);
    const expected = reference.compile(source);
    const exposed = Compile(parameters);
    for (const [values, result] of [
      [valid, true],
      [invalid, false],
    ] as const) {
      for (const value of values) {
        expect(expected(value), JSON.stringify(value)).toBe(result);
        expect(validator.Check(value), JSON.stringify(value)).toBe(result);
        expect(exposed.Check(value), JSON.stringify(value)).toBe(result);
      }
    }
    expect(source).toEqual(original);
  },
);

test("literal instance data and property names are never interpreted as schema keywords", () => {
  const literal = {
    $schema: "https://SECRET.test",
    $ref: "https://SECRET.test/ref",
    dependentRequired: { a: "literal, not a schema" },
  };
  const annotations = { ...literal, arrays: [[true, null]] };
  const source = {
    $schema: draft07,
    type: "object",
    title: "Example",
    description: "Metadata",
    $comment: "Comment",
    default: annotations,
    examples: [annotations],
    definitions: { unused: { type: "string" } },
    properties: {
      payload: { const: literal, readOnly: true, writeOnly: false },
      $ref: { enum: [literal] },
      dependentRequired: { type: "boolean" },
    },
    required: ["payload"],
  };
  const { parameters, validator } = prepareSchema(source);
  expect(parameters).toEqual({ ...source, $schema: modern });
  expect(
    validator.Check({
      payload: literal,
      $ref: literal,
      dependentRequired: true,
    }),
  ).toBe(true);
  expect(validator.Check({ payload: {} })).toBe(false);
});

test.each([
  [{ $ref: "#/definitions/text" }, "draft07-reference"],
  [{ $ref: "https://SECRET.test" }, "draft07-reference"],
  [{ $dynamicRef: "#text" }, "draft07-reference"],
  [{ items: [{ type: "string" }] }, "draft07-tuple"],
  [{ dependencies: { a: ["b"] } }, "draft07-dependencies"],
  [{ dependencies: { a: { required: ["b"] } } }, "draft07-dependencies"],
  [{ $id: "https://SECRET.test" }, "draft07-resource"],
  [{ format: "email" }, "draft07-format"],
  [{ additionalItems: false }, "draft07-keyword"],
  [{ dependentRequired: { a: ["b"] } }, "draft07-keyword"],
  [{ prefixItems: [false] }, "draft07-keyword"],
  [{ unevaluatedProperties: false }, "draft07-keyword"],
  [{ minContains: 2 }, "draft07-keyword"],
  [{ contentEncoding: "base64" }, "draft07-keyword"],
  [{ "SECRET-unknown-keyword": true }, "draft07-keyword"],
] satisfies [Record<string, unknown>, RejectionCode][])(
  "rejects unverified constructs %j",
  (fragment, code) => {
    expectRejection({ $schema: draft07, type: "object", ...fragment }, code);
    expectRejection(
      { $schema: draft07, type: "object", properties: { nested: fragment } },
      code,
    );
  },
);

test("never applies modern sibling semantics to a draft-07 reference", () => {
  // Draft-07 core §8.3 ignores the sibling type:number; 'text' is valid there.
  // https://json-schema.org/draft-07/draft-handrews-json-schema-01#rfc.section.8.3
  expectRejection(legacySchema, "draft07-reference");
  const { $schema, ...stripped } = legacySchema;
  expect(compileSchema(stripped).Check({ message: "text" })).toBe(false);
});

test.each([draft07, modern, "https://SECRET.test"])(
  "rejects embedded dialect %s",
  ($schema) => {
    expectRejection(
      {
        $schema: draft07,
        definitions: { nested: { $schema, type: "string" } },
      },
      "embedded-dialect",
    );
  },
);

test("default/modern schemas do not opt embedded resources into draft-07", () => {
  expectRejection(
    { type: "object", $defs: { nested: { $schema: draft07, type: "string" } } },
    "unsupported-dialect",
  );
});

test.each([
  { type: "not-a-type" },
  { properties: { value: { type: "not-a-type" } } },
  { minLength: -1 },
  { required: "value" },
  { items: [] },
  { properties: null },
  { properties: { value: { pattern: "SECRET[" } } },
])("rejects invalid source syntax or compilation safely (%j)", (fragment) => {
  expectRejection({ $schema: draft07, ...fragment }, "invalid-schema");
});

test("preserves size and depth limits for both dialects", () => {
  for (const $schema of [draft07, modern]) {
    expectRejection(
      { $schema, description: "x".repeat(70_000) },
      "schema-too-large",
    );
    let nested: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 65; depth++) nested = { not: nested };
    expectRejection({ $schema, ...nested }, "schema-too-deep");
  }
});

test("SDK output validation uses the same normalized draft-07 subset", () => {
  const validator = schemaValidator.getValidator({
    $schema: draft07,
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  });
  expect(validator({ ok: true }).valid).toBe(true);
  expect(validator({ ok: "true" }).valid).toBe(false);
  expect(validator({ ok: true, extra: 1 }).valid).toBe(false);
});
