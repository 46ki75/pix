import type { TSchema } from "@earendil-works/pi-ai";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Compile } from "typebox/compile";

const syntax = new Ajv2020({ strict: false, validateFormats: false });
const dialect = "https://json-schema.org/draft/2020-12/schema";
const schemaMaps = new Set([
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaValues = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "additionalItems",
  "unevaluatedItems",
  "contentSchema",
]);

function checkSchemaSupport(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const schema = value as Record<string, unknown>;
  // Pi validates the exposed schema with TypeBox before execute. A different
  // private validator cannot repair legacy semantics there (e.g. draft-07 must
  // ignore $ref siblings). Reject legacy dialects, including embedded resources,
  // rather than misrepresent them as supported or silently relabeling the schema.
  if (
    schema.$schema !== undefined &&
    (typeof schema.$schema !== "string" ||
      schema.$schema.replace(/#$/, "") !== dialect)
  ) {
    throw new Error("Invalid or unsupported MCP JSON Schema dialect.");
  }
  for (const keyword of ["$ref", "$dynamicRef", "$recursiveRef"]) {
    const reference = schema[keyword];
    if (typeof reference === "string" && !reference.startsWith("#")) {
      throw new Error("External MCP schema references are unsupported.");
    }
  }
  // const/enum/default/examples and unknown annotation keywords contain instance
  // data, not schemas: a literal {$ref: 'https://...'} there must remain legal.
  for (const [keyword, child] of Object.entries(schema)) {
    if (schemaMaps.has(keyword) || keyword === "dependencies") {
      for (const nested of Object.values(child as Record<string, unknown>))
        checkSchemaSupport(nested);
    } else if (schemaArrays.has(keyword) || keyword === "items") {
      if (Array.isArray(child)) child.forEach(checkSchemaSupport);
      else checkSchemaSupport(child);
    } else if (schemaValues.has(keyword)) checkSchemaSupport(child);
  }
}

export function compileSchema(schema: Record<string, unknown>) {
  const serialized = JSON.stringify(schema);
  if (Buffer.byteLength(serialized) > 64 * 1024)
    throw new Error("MCP schema exceeds 64 KiB.");
  const checkDepth = (value: unknown, depth: number): void => {
    if (depth > 64) throw new Error("MCP schema is too deeply nested.");
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) checkDepth(child, depth + 1);
  };
  checkDepth(schema, 0);
  // TypeBox code generation is not schema syntax validation: unknown type names
  // can compile into always-true checks. Validate the dialect's meta-schema first.
  // Validate against the supported meta-schema directly, without consulting an
  // untrusted $schema URI or attempting to load a remote meta-schema.
  if (syntax.validate(dialect, schema) !== true)
    throw new Error("Invalid or unsupported MCP JSON Schema.");
  checkSchemaSupport(schema);
  return Compile(schema as TSchema);
}

// Use Pi's validator family for SDK output validation too, rather than silently
// downgrading MCP's default 2020-12 schemas to the SDK's default draft-07 validator.
export const schemaValidator: jsonSchemaValidator = {
  getValidator<T>(schema: Record<string, unknown>) {
    const validator = compileSchema(schema);
    return (input: unknown) =>
      validator.Check(input)
        ? { valid: true, data: input as T, errorMessage: undefined }
        : {
            valid: false,
            data: undefined,
            errorMessage: "Result does not match the advertised MCP schema.",
          };
  },
};
