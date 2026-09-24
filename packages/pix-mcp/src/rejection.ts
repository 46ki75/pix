// Discovery may expose only these adapter-owned messages, never compiler/SDK
// exceptions: schemas, dialect URLs, and exception payloads can contain secrets.
const messages = {
  "invalid-schema": "Invalid or unsupported MCP JSON Schema.",
  "unsupported-dialect":
    "Invalid or unsupported MCP JSON Schema dialect. Use 2020-12 or the documented draft-07 subset.",
  "embedded-dialect":
    "Embedded dialect declarations are unsupported in the draft-07 subset.",
  "draft07-reference":
    "Draft-07 references are unsupported. Supply an equivalent reference-free schema or a 2020-12 schema.",
  "draft07-tuple":
    "Draft-07 tuple items are unsupported. Supply an equivalent 2020-12 schema using prefixItems.",
  "draft07-dependencies":
    "Draft-07 dependencies are unsupported. Supply an equivalent 2020-12 schema using dependentRequired/dependentSchemas.",
  "draft07-resource":
    "Draft-07 resource identifiers ($id) are unsupported in the compatible subset.",
  "draft07-format":
    "Draft-07 format validation is unsupported in the compatible subset.",
  "draft07-keyword":
    "An unsupported draft-07 keyword is present. Use the documented subset or supply an equivalent 2020-12 schema.",
  "draft07-length":
    "Draft-07 string length bounds outside the safe integer range are unsupported.",
  "draft07-property-name":
    "Draft-07 properties/required names inherited from Object.prototype are unsupported by Pi's native validator.",
  "draft07-unique-items":
    "Draft-07 uniqueItems:true is unsupported because Pi's native validator can conflate distinct values.",
  "draft07-multiple-of":
    "Draft-07 multipleOf is unsupported because Pi's native validator uses inexact numeric comparisons.",
  "draft07-literal-array":
    "Draft-07 const/enum literals containing arrays are unsupported because Pi's native equality check can conflate arrays and objects.",
  "draft07-pattern-backreference":
    "Draft-07 patternProperties with numeric backreferences are unsupported because Pi's native validator changes their capture indices.",
  "external-reference": "External MCP schema references are unsupported.",
  "schema-too-large": "MCP schema exceeds 64 KiB.",
  "schema-too-deep": "MCP schema is too deeply nested.",
  "invalid-tool-metadata":
    "Unsupported tool metadata: names require 1–128 ASCII letters, digits, underscores, hyphens, or periods; descriptions must not exceed 16 KiB.",
  "tasks-required": "Tools requiring MCP task execution are unsupported.",
  "name-collision": "The native tool name conflicts with another tool.",
  "registration-failed": "Native tool registration failed.",
} as const;

export type RejectionCode = keyof typeof messages;

export class ToolRejectionError extends Error {
  readonly code: RejectionCode;

  constructor(code: RejectionCode) {
    super(messages[code]);
    this.name = "ToolRejectionError";
    this.code = code;
  }
}
