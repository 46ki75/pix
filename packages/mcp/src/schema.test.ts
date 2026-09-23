import { expect, test } from "vitest";
import { compileSchema, schemaValidator } from "./schema.ts";
import { legacySchema } from "./fixtures/server.ts";

test("preserves native JSON Schema constraints and local references", () => {
  const schema = {
    type: "object",
    $defs: { id: { type: "string", pattern: "^[a-z]+$" } },
    properties: {
      id: { $ref: "#/$defs/id" },
      count: { type: "integer", minimum: 1 },
      optional: { type: ["string", "null"] },
    },
    required: ["id", "count"],
    additionalProperties: false,
  };
  const validator = compileSchema(schema);
  expect(validator.Check({ id: "abc", count: 1, optional: null })).toBe(true);
  expect(validator.Check({ id: "123", count: 1 })).toBe(false);
  expect(validator.Check({ id: "abc", count: 0 })).toBe(false);
  expect(validator.Check({ id: "abc", count: 1, extra: true })).toBe(false);
  expect(validator.Check({ id: "abc", count: "1" })).toBe(false);
});

test.each([
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2020-12/schema#",
])("syntax-checks explicitly declared supported dialect %s", ($schema) => {
  const validator = compileSchema({
    $schema,
    type: "object",
    properties: { count: { type: "integer", minimum: 1 } },
  });
  expect(validator.Check({ count: 1 })).toBe(true);
  expect(validator.Check({ count: 0 })).toBe(false);
  expect(() =>
    compileSchema({
      $schema,
      type: "object",
      properties: { count: { type: "invalid" } },
    }),
  ).toThrow();
});

test.each([
  "http://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2019-09/schema",
])(
  "legacy dialect %s fails closed instead of using modern validation semantics",
  ($schema) => {
    expect(() => compileSchema({ ...legacySchema, $schema })).toThrow(
      "unsupported",
    );
  },
);

test("embedded resources cannot opt into an unsupported dialect", () => {
  expect(() =>
    compileSchema({
      type: "object",
      $defs: { legacy: { ...legacySchema, $id: "legacy" } },
    }),
  ).toThrow("unsupported");
});

test("unknown schema dialects fail without fetching a meta-schema", () => {
  expect(() =>
    compileSchema({ $schema: "https://example.test/unknown", type: "object" }),
  ).toThrow("unsupported");
});

test("SDK output validation rejects mismatched structured data", () => {
  const validator = schemaValidator.getValidator({
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  });
  expect(validator({ ok: true }).valid).toBe(true);
  expect(validator({ ok: "true" }).valid).toBe(false);
});

test("rejects malformed nested schema syntax rather than compiling a permissive validator", () => {
  expect(() =>
    compileSchema({
      type: "object",
      properties: { value: { type: "not-a-json-schema-type" } },
    }),
  ).toThrow();
  expect(() =>
    schemaValidator.getValidator({
      type: "object",
      properties: { value: { type: "not-a-json-schema-type" } },
    }),
  ).toThrow();
});

test("literal instance and annotation data are not schema references", () => {
  const literal = { $ref: "https://example.test/document" };
  const validator = compileSchema({
    type: "object",
    properties: {
      payload: { const: literal, default: literal, examples: [literal] },
    },
    required: ["payload"],
  });
  expect(validator.Check({ payload: literal })).toBe(true);
  expect(validator.Check({ payload: {} })).toBe(false);
  expect(() =>
    compileSchema({
      type: "object",
      properties: { payload: { $ref: "https://example.test/document" } },
    }),
  ).toThrow("External");
});

test("rejects external references and oversized schemas", () => {
  expect(() =>
    compileSchema({ $ref: "https://example.test/schema.json" }),
  ).toThrow("External");
  expect(() =>
    compileSchema({ type: "object", description: "x".repeat(70_000) }),
  ).toThrow("64 KiB");
});
