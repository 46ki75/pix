import type { TSchema } from "@earendil-works/pi-ai";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Compile } from "typebox/compile";
import { ToolRejectionError } from "./rejection.ts";

const syntax = new Ajv2020({ strict: false, validateFormats: false });
const legacySyntax = new Ajv({ strict: false, validateFormats: false });
const dialect = "https://json-schema.org/draft/2020-12/schema";
const legacyDialect = "http://json-schema.org/draft-07/schema";
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

// An allowlist, not a blacklist: a newer or custom keyword could acquire a
// constraint when interpreted by Pi's TypeBox validator. Instance/annotation
// data is copied verbatim, never traversed as a schema.
const legacyKeywords = new Set([
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "type",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "properties",
  "patternProperties",
  "additionalProperties",
  "required",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "definitions",
]);

function containsArray(value: unknown): boolean {
  return (
    Array.isArray(value) ||
    (value !== null &&
      typeof value === "object" &&
      Object.values(value).some(containsArray))
  );
}

function hasNumericBackreference(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === "\\" && /[1-9]/.test(pattern[++index] ?? ""))
      return true;
  }
  return false;
}

function normalizeLegacy(value: unknown, root = false): unknown {
  if (typeof value === "boolean") return value;
  const schema = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    Object.entries(schema).map(([keyword, child]) => {
      if (keyword === "$schema") {
        if (!root) throw new ToolRejectionError("embedded-dialect");
        return [keyword, dialect];
      }
      if (["$ref", "$dynamicRef", "$recursiveRef"].includes(keyword))
        throw new ToolRejectionError("draft07-reference");
      if (keyword === "items" && Array.isArray(child))
        throw new ToolRejectionError("draft07-tuple");
      if (keyword === "dependencies")
        throw new ToolRejectionError("draft07-dependencies");
      if (keyword === "$id") throw new ToolRejectionError("draft07-resource");
      if (keyword === "format") throw new ToolRejectionError("draft07-format");
      // TypeBox 1.3 uses a numeric tolerance for multiples and lossy hashes for
      // uniqueness. A private validator cannot fix Pi's native acceptance set.
      if (keyword === "multipleOf")
        throw new ToolRejectionError("draft07-multiple-of");
      if (keyword === "uniqueItems" && child === true)
        throw new ToolRejectionError("draft07-unique-items");
      // TypeBox and Pi's preprocessing use `in` for properties/required. Reject
      // prototype-sensitive names even when optional: inherited values can fail
      // a property constraint or satisfy a requirement on an absent JSON key.
      if (
        (keyword === "required" &&
          (child as string[]).some((name) => name in Object.prototype)) ||
        (keyword === "properties" &&
          Object.keys(child as object).some((name) => name in Object.prototype))
      )
        throw new ToolRejectionError("draft07-property-name");
      // TypeBox's deep equality can equate array literals with objects such as
      // {length:0}. Inspect literal structure only for that defect, not for schema
      // keywords; default/examples remain unrestricted instance data.
      if (
        (keyword === "const" && containsArray(child)) ||
        (keyword === "enum" && (child as unknown[]).some(containsArray))
      )
        throw new ToolRejectionError("draft07-literal-array");
      // additionalProperties combines these patterns inside a capturing group,
      // changing numeric backreference indices. Reject rather than rewrite regex
      // syntax; escaped backslashes and named backreferences keep their meaning.
      if (
        keyword === "patternProperties" &&
        Object.keys(child as object).some(hasNumericBackreference)
      )
        throw new ToolRejectionError("draft07-pattern-backreference");
      if (!legacyKeywords.has(keyword))
        throw new ToolRejectionError("draft07-keyword");
      if (schemaMaps.has(keyword)) {
        return [
          keyword,
          Object.fromEntries(
            Object.entries(child as Record<string, unknown>).map(
              ([name, nested]) => [name, normalizeLegacy(nested)],
            ),
          ),
        ];
      }
      if (schemaArrays.has(keyword))
        return [
          keyword,
          (child as unknown[]).map((item) => normalizeLegacy(item)),
        ];
      if (schemaValues.has(keyword) || keyword === "items")
        return [keyword, normalizeLegacy(child)];
      return [keyword, child];
    }),
  );
  if (
    normalized.minLength !== undefined ||
    normalized.maxLength !== undefined
  ) {
    const minimum = (normalized.minLength ?? 0) as number;
    const maximum = normalized.maxLength as number | undefined;
    if (
      !Number.isSafeInteger(minimum) ||
      (maximum !== undefined && !Number.isSafeInteger(maximum))
    )
      throw new ToolRejectionError("draft07-length");
    // TypeBox counts grapheme clusters for min/maxLength, not JSON Schema code
    // points. Its Unicode regex engine does count code points, including astral
    // characters. Match all characters (also newlines), and preserve any existing
    // pattern/allOf rather than overwriting a constraint. Bounds without type
    // must still accept non-strings, including when the bounds contradict.
    const pattern =
      maximum !== undefined && minimum > maximum
        ? "(?!)"
        : `^[\\s\\S]{${minimum},${maximum ?? ""}}(?![\\s\\S])`;
    delete normalized.minLength;
    delete normalized.maxLength;
    if (normalized.pattern === undefined) normalized.pattern = pattern;
    else
      normalized.allOf = [
        ...((normalized.allOf as unknown[] | undefined) ?? []),
        { pattern },
      ];
  }
  const properties = normalized.properties as
    | Record<string, unknown>
    | undefined;
  if (
    normalized.additionalProperties === false &&
    properties !== undefined &&
    normalized.patternProperties === undefined &&
    Array.isArray(normalized.required) &&
    Object.keys(properties).length === normalized.required.length &&
    normalized.required.some((name) => !Object.hasOwn(properties, name))
  ) {
    // TypeBox's fast path compares key counts, not sets. An empty pattern map
    // changes no constraints but selects its correct standard property check.
    normalized.patternProperties = {};
  }
  return normalized;
}

function checkSchemaSupport(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const schema = value as Record<string, unknown>;
  // A 2020-12 document cannot silently opt an embedded resource into legacy
  // semantics. Draft-07 normalization is intentionally limited to whole schemas.
  if (
    schema.$schema !== undefined &&
    (typeof schema.$schema !== "string" ||
      schema.$schema.replace(/#$/, "") !== dialect)
  ) {
    throw new ToolRejectionError("unsupported-dialect");
  }
  for (const keyword of ["$ref", "$dynamicRef", "$recursiveRef"]) {
    const reference = schema[keyword];
    if (typeof reference === "string" && !reference.startsWith("#")) {
      throw new ToolRejectionError("external-reference");
    }
  }
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

function checkLimits(schema: unknown): void {
  const checkDepth = (value: unknown, depth: number): void => {
    if (depth > 64) throw new ToolRejectionError("schema-too-deep");
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) checkDepth(child, depth + 1);
  };
  checkDepth(schema, 0);
  if (Buffer.byteLength(JSON.stringify(schema)) > 64 * 1024)
    throw new ToolRejectionError("schema-too-large");
}

export function prepareSchema(schema: Record<string, unknown>) {
  try {
    checkLimits(schema);
    const declared = schema.$schema;
    const uri =
      typeof declared === "string" ? declared.replace(/#$/, "") : declared;
    const legacy =
      uri === legacyDialect || uri === legacyDialect.replace("http:", "https:");
    if (declared !== undefined && !legacy && uri !== dialect)
      throw new ToolRejectionError("unsupported-dialect");
    if (legacy && legacySyntax.validate(legacyDialect, schema) !== true)
      throw new ToolRejectionError("invalid-schema");
    const parameters = (
      legacy ? normalizeLegacy(schema, true) : schema
    ) as TSchema;
    if (legacy) checkLimits(parameters);
    // TypeBox compilation is not syntax validation. Use only bundled meta-schemas,
    // never an untrusted $schema URI, both before and after normalization.
    if (syntax.validate(dialect, parameters) !== true)
      throw new ToolRejectionError("invalid-schema");
    checkSchemaSupport(parameters);
    return { parameters, validator: Compile(parameters) };
  } catch (error) {
    if (error instanceof ToolRejectionError) throw error;
    throw new ToolRejectionError("invalid-schema");
  }
}

export function compileSchema(schema: Record<string, unknown>) {
  return prepareSchema(schema).validator;
}

// Input exposure and SDK/output validation share normalization and the same
// validator family. A private legacy validator cannot repair Pi's native schema.
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
