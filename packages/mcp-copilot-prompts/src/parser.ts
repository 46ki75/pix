import { basename } from "node:path";
import { parseDocument } from "yaml";
import {
  MAX_DESCRIPTION_BYTES,
  MAX_INPUTS,
  MAX_NAME_BYTES,
  MAX_PROMPT_FILE_BYTES,
} from "./limits.js";
import type {
  CopilotPromptMetadata,
  PortablePrompt,
  PromptInput,
} from "./types.js";
import { byteLength, hasUnsafeText, sha256 } from "./util.js";

const PROMPT_SUFFIX = ".prompt.md";
const INPUT_VARIABLE = /\$\{input:([^}:]+)(?::([^}]*))?\}/gu;

export class PromptParseError extends Error {}

interface FrontmatterParts {
  body: string;
  frontmatter?: string;
}

function splitFrontmatter(source: string): FrontmatterParts {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const opening = /^---[\t ]*\r?\n/u.exec(text);
  if (!opening) return { body: text };

  let offset = opening[0].length;
  while (offset <= text.length) {
    const newline = text.indexOf("\n", offset);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(offset, lineEnd).replace(/\r$/u, "");
    if (/^---[\t ]*$/u.test(line)) {
      const bodyStart = newline === -1 ? lineEnd : newline + 1;
      return {
        frontmatter: text.slice(opening[0].length, offset),
        body: text.slice(bodyStart),
      };
    }
    if (newline === -1) break;
    offset = newline + 1;
  }
  throw new PromptParseError(
    "frontmatter is missing its closing --- delimiter",
  );
}

function parseFrontmatter(source: string): Record<string, unknown> {
  if (source.trim() === "") return {};
  const document = parseDocument(source, {
    customTags: [],
    prettyErrors: false,
    resolveKnownTags: false,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new PromptParseError(`invalid YAML: ${document.errors[0]?.message}`);
  }
  if (document.warnings.length > 0) {
    throw new PromptParseError(
      `unsupported YAML: ${document.warnings[0]?.message}`,
    );
  }
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new PromptParseError("frontmatter must be a mapping");
  }
  return value as Record<string, unknown>;
}

function optionalString(
  data: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string | undefined {
  if (!Object.hasOwn(data, key)) return undefined;
  const value = data[key];
  if (typeof value !== "string") {
    throw new PromptParseError(`${key} must be a string`);
  }
  if (byteLength(value) > maxBytes) {
    throw new PromptParseError(`${key} exceeds ${maxBytes} bytes`);
  }
  if (hasUnsafeText(value)) {
    throw new PromptParseError(
      `${key} contains unsupported control characters`,
    );
  }
  return value;
}

function optionalTools(data: Record<string, unknown>): string[] | undefined {
  if (!Object.hasOwn(data, "tools")) return undefined;
  const value = data.tools;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new PromptParseError("tools must be an array of strings");
  }
  if (value.length > MAX_INPUTS) {
    throw new PromptParseError(
      `tools contains more than ${MAX_INPUTS} entries`,
    );
  }
  for (const tool of value as string[]) {
    if (
      tool.length === 0 ||
      byteLength(tool) > MAX_NAME_BYTES ||
      hasUnsafeText(tool)
    ) {
      throw new PromptParseError("tools contains an invalid tool name");
    }
  }
  return value as string[];
}

function validateName(name: string, field: string): string {
  if (name.length === 0)
    throw new PromptParseError(`${field} must not be empty`);
  if (byteLength(name) > MAX_NAME_BYTES) {
    throw new PromptParseError(`${field} exceeds ${MAX_NAME_BYTES} bytes`);
  }
  if (hasUnsafeText(name)) {
    throw new PromptParseError(
      `${field} contains unsupported control characters`,
    );
  }
  return name;
}

function extractInputs(body: string): PromptInput[] {
  const inputs = new Map<string, PromptInput>();
  for (const match of body.matchAll(INPUT_VARIABLE)) {
    const rawName = match[1] ?? "";
    if (rawName !== rawName.trim()) {
      throw new PromptParseError(
        "input variable names cannot start or end with whitespace",
      );
    }
    const name = validateName(rawName, "input variable name");
    const placeholder = match[2];
    if (
      placeholder !== undefined &&
      (byteLength(placeholder) > MAX_DESCRIPTION_BYTES ||
        hasUnsafeText(placeholder))
    ) {
      throw new PromptParseError(
        `input variable ${name} has an invalid placeholder`,
      );
    }
    const existing = inputs.get(name);
    if (!existing) {
      inputs.set(name, {
        name,
        ...(placeholder === undefined ? {} : { placeholder }),
      });
    } else if (
      existing.placeholder !== undefined &&
      placeholder !== undefined &&
      existing.placeholder !== placeholder
    ) {
      throw new PromptParseError(
        `input variable ${name} uses conflicting placeholders`,
      );
    } else if (
      existing.placeholder === undefined &&
      placeholder !== undefined
    ) {
      inputs.set(name, { name, placeholder });
    }
  }
  if (inputs.size > MAX_INPUTS) {
    throw new PromptParseError(
      `prompt declares more than ${MAX_INPUTS} inputs`,
    );
  }
  return [...inputs.values()];
}

export function parsePromptFile(
  source: string,
  sourcePath: string,
  rootPath: string,
  sourceRealPath = sourcePath,
): PortablePrompt {
  if (byteLength(source) > MAX_PROMPT_FILE_BYTES) {
    throw new PromptParseError(
      `prompt file exceeds ${MAX_PROMPT_FILE_BYTES} bytes`,
    );
  }
  const { body, frontmatter } = splitFrontmatter(source);
  const data = frontmatter === undefined ? {} : parseFrontmatter(frontmatter);
  const fallbackName = basename(sourcePath).slice(0, -PROMPT_SUFFIX.length);
  const name = validateName(
    optionalString(data, "name", MAX_NAME_BYTES) ?? fallbackName,
    "name",
  );
  const description = optionalString(
    data,
    "description",
    MAX_DESCRIPTION_BYTES,
  );
  const argumentHint = optionalString(
    data,
    "argument-hint",
    MAX_DESCRIPTION_BYTES,
  );
  const agent = optionalString(data, "agent", MAX_NAME_BYTES);
  const model = optionalString(data, "model", MAX_NAME_BYTES);
  const tools = optionalTools(data);
  const metadata: CopilotPromptMetadata = {
    ...(argumentHint === undefined ? {} : { argumentHint }),
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(tools === undefined ? {} : { tools }),
  };
  return {
    rootPath,
    sourcePath,
    sourceRealPath,
    name,
    ...(description === undefined ? {} : { description }),
    body,
    inputs: extractInputs(body),
    metadata,
    contentHash: sha256(source),
  };
}
