import { basename, relative } from "node:path";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_ARGUMENT_BYTES,
  MAX_INPUTS,
  MAX_RENDERED_PROMPT_BYTES,
} from "./limits.js";
import { loadReferenceMessages, type ReferenceOptions } from "./references.js";
import type { PortablePrompt } from "./types.js";
import { byteLength, sanitizeInline } from "./util.js";

const VARIABLE = /\$\{([^}]*)\}/gu;
const INPUT_PREFIX = "$" + "{input:";
const META_KEY = "cloud.ikuma/mcp-copilot-prompts";

export class PromptRenderError extends Error {}

export function renderBody(
  prompt: PortablePrompt,
  arguments_: Record<string, string> | undefined,
): string {
  const supplied = arguments_ ?? {};
  const suppliedEntries = Object.entries(supplied);
  if (suppliedEntries.length > MAX_INPUTS) {
    throw new PromptRenderError(
      `prompt arguments contain more than ${MAX_INPUTS} entries`,
    );
  }
  const argumentBytes = suppliedEntries.reduce(
    (total, [name, value]) => total + byteLength(name) + byteLength(value),
    0,
  );
  if (argumentBytes > MAX_ARGUMENT_BYTES) {
    throw new PromptRenderError(
      `prompt arguments exceed ${MAX_ARGUMENT_BYTES} bytes`,
    );
  }
  const declared = new Set(prompt.inputs.map((input) => input.name));
  const unknownArguments = suppliedEntries
    .map(([name]) => name)
    .filter((name) => !declared.has(name));
  if (unknownArguments.length > 0) {
    throw new PromptRenderError(
      `unknown prompt arguments: ${unknownArguments.map((name) => sanitizeInline(name)).join(", ")}`,
    );
  }
  const missing = prompt.inputs
    .filter((input) => !Object.hasOwn(supplied, input.name))
    .map((input) => input.name);
  if (missing.length > 0) {
    throw new PromptRenderError(
      `missing required prompt arguments: ${missing.join(", ")}`,
    );
  }

  const variableValue = (expression: string): string | undefined => {
    if (expression === "workspaceFolder") return prompt.rootPath;
    if (expression === "workspaceFolderBasename") {
      return basename(prompt.rootPath);
    }
    if (expression.startsWith("input:")) {
      const remainder = expression.slice("input:".length);
      const separator = remainder.indexOf(":");
      const name = separator === -1 ? remainder : remainder.slice(0, separator);
      if (!declared.has(name) || !Object.hasOwn(supplied, name))
        return undefined;
      return supplied[name] ?? "";
    }
    return undefined;
  };

  const unsupported = new Set<string>();
  let projectedBytes = byteLength(prompt.body);
  for (const match of prompt.body.matchAll(VARIABLE)) {
    const original = match[0];
    const value = variableValue(match[1] ?? "");
    if (value === undefined) {
      unsupported.add(original);
    } else {
      projectedBytes += byteLength(value) - byteLength(original);
    }
  }
  if (prompt.body.replace(VARIABLE, "").includes(INPUT_PREFIX)) {
    unsupported.add(`malformed ${INPUT_PREFIX}...} variable`);
  }
  if (unsupported.size > 0) {
    throw new PromptRenderError(
      `unsupported prompt variables: ${[...unsupported]
        .map((value) => sanitizeInline(value))
        .join(", ")}`,
    );
  }
  if (projectedBytes > MAX_RENDERED_PROMPT_BYTES) {
    throw new PromptRenderError(
      `rendered prompt exceeds ${MAX_RENDERED_PROMPT_BYTES} bytes`,
    );
  }
  return prompt.body.replace(
    VARIABLE,
    (original, expression: string) => variableValue(expression) ?? original,
  );
}

function compatibilityMetadata(
  prompt: PortablePrompt,
): Record<string, unknown> {
  return {
    source: relative(prompt.rootPath, prompt.sourcePath),
    ...(prompt.metadata.argumentHint === undefined
      ? {}
      : { argumentHint: prompt.metadata.argumentHint }),
    ...(prompt.metadata.agent === undefined
      ? {}
      : { agent: prompt.metadata.agent }),
    ...(prompt.metadata.model === undefined
      ? {}
      : { model: prompt.metadata.model }),
    ...(prompt.metadata.tools === undefined
      ? {}
      : { tools: prompt.metadata.tools }),
  };
}

export async function renderPrompt(
  prompt: PortablePrompt,
  arguments_: Record<string, string> | undefined,
  options: ReferenceOptions,
): Promise<GetPromptResult> {
  const text = renderBody(prompt, arguments_);
  // Discover references from the original body so prompt arguments cannot make
  // the server read arbitrary paths.
  const references = await loadReferenceMessages(prompt, options);
  return {
    ...(prompt.description === undefined
      ? {}
      : { description: prompt.description }),
    messages: [
      { role: "user", content: { type: "text", text } },
      ...references,
    ],
    _meta: { [META_KEY]: compatibilityMetadata(prompt) },
  };
}
