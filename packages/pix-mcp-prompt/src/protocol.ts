import type { ContentBlock } from "@earendil-works/pi-mcp";

export interface Prompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
  _meta?: Record<string, unknown>;
}

export interface GetPromptResult {
  description?: string;
  messages: { role: "user" | "assistant"; content: ContentBlock }[];
}

export interface ListPromptsResult {
  prompts: Prompt[];
  nextCursor?: string;
}

export const MAX_PROMPT_IDENTIFIER_BYTES = 256;
export const MAX_PROMPT_METADATA_BYTES = 16 * 1024;
export const MAX_PROMPT_ARGUMENTS = 100;
export const MAX_PROMPTS = 1_000;
export const MAX_PROMPT_CATALOG_BYTES = 2 * 1024 * 1024;
export const MAX_PROMPT_CURSORS = 100;
export const MAX_PROMPT_ARGUMENT_BYTES = 256 * 1024;
export const MAX_PROMPT_MESSAGES = 100;
export const MAX_PROMPT_RESULT_BYTES = 16 * 1024 * 1024;

function invalid(what: string): never {
  throw new Error(`Invalid MCP ${what}.`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (!isObject(value)) invalid(what);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") invalid(what);
  return value;
}

function optionalText(
  value: unknown,
  key: string,
  what: string,
): string | undefined {
  const candidate = object(value, what)[key];
  return candidate === undefined ? undefined : text(candidate, what);
}

function metadata(
  value: unknown,
  key: string,
  what: string,
): Record<string, unknown> | undefined {
  const candidate = object(value, what)[key];
  if (candidate === undefined) return undefined;
  return { ...object(candidate, what) };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value);
}

function jsonByteLength(value: unknown, what: string): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) invalid(what);
    return byteLength(serialized);
  } catch {
    return invalid(what);
  }
}

function identifier(value: unknown, what: string): string {
  const result = text(value, what);
  const bytes = byteLength(result);
  // Prompt identifiers reach command UI and diagnostics. Exclude invisible and
  // line-breaking characters that can spoof those surfaces.
  if (
    bytes === 0 ||
    bytes > MAX_PROMPT_IDENTIFIER_BYTES ||
    /[\p{C}\p{Zl}\p{Zp}]/u.test(result)
  )
    invalid(what);
  return result;
}

function boundedMetadata(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  const result = text(value, what);
  if (byteLength(result) > MAX_PROMPT_METADATA_BYTES) invalid(what);
  return result;
}

function parsePrompt(value: unknown): Prompt {
  const input = object(value, "prompt metadata");
  const name = identifier(input.name, "prompt name");
  const title = boundedMetadata(input.title, "prompt title");
  const description = boundedMetadata(input.description, "prompt description");
  const meta = metadata(input, "_meta", "prompt metadata");
  let args: Prompt["arguments"];
  if (input.arguments !== undefined) {
    if (
      !Array.isArray(input.arguments) ||
      input.arguments.length > MAX_PROMPT_ARGUMENTS
    )
      invalid("prompt arguments");
    const names = new Set<string>();
    args = input.arguments.map((value) => {
      const argument = object(value, "prompt argument metadata");
      const argumentName = identifier(argument.name, "prompt argument name");
      if (names.has(argumentName)) invalid("duplicate prompt argument name");
      names.add(argumentName);
      const argumentDescription = boundedMetadata(
        argument.description,
        "prompt argument description",
      );
      if (
        argument.required !== undefined &&
        typeof argument.required !== "boolean"
      )
        invalid("prompt argument requirement");
      return {
        name: argumentName,
        ...(argumentDescription === undefined
          ? {}
          : { description: argumentDescription }),
        ...(argument.required === undefined
          ? {}
          : { required: argument.required }),
      };
    });
  }
  return {
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(args === undefined ? {} : { arguments: args }),
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

/** Validate and normalize one unknown `prompts/list` result page. */
export function parseListPromptsResult(value: unknown): ListPromptsResult {
  if (jsonByteLength(value, "prompts/list result") > MAX_PROMPT_CATALOG_BYTES)
    invalid("prompts/list result size");
  const input = object(value, "prompts/list result");
  if (!Array.isArray(input.prompts) || input.prompts.length > MAX_PROMPTS)
    invalid("prompts/list result");
  const nextCursor = optionalText(input, "nextCursor", "prompts/list cursor");
  const names = new Set<string>();
  const prompts = input.prompts.map((value) => {
    const prompt = parsePrompt(value);
    if (names.has(prompt.name)) invalid("duplicate prompt name");
    names.add(prompt.name);
    return prompt;
  });
  return {
    prompts,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function parseAnnotations(
  value: unknown,
): ContentBlock["annotations"] | undefined {
  if (value === undefined) return undefined;
  const input = object(value, "content annotations");
  let audience: ("user" | "assistant")[] | undefined;
  if (input.audience !== undefined) {
    if (
      !Array.isArray(input.audience) ||
      input.audience.some((role) => role !== "user" && role !== "assistant")
    )
      invalid("content annotations");
    audience = [...input.audience] as ("user" | "assistant")[];
  }
  if (
    input.priority !== undefined &&
    (typeof input.priority !== "number" ||
      !Number.isFinite(input.priority) ||
      input.priority < 0 ||
      input.priority > 1)
  )
    invalid("content annotations");
  if (
    input.lastModified !== undefined &&
    typeof input.lastModified !== "string"
  )
    invalid("content annotations");
  return {
    ...(audience === undefined ? {} : { audience }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.lastModified === undefined
      ? {}
      : { lastModified: input.lastModified }),
  };
}

function commonContent(value: Record<string, unknown>) {
  const annotations = parseAnnotations(value.annotations);
  const meta = metadata(value, "_meta", "content metadata");
  return {
    ...(annotations === undefined ? {} : { annotations }),
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

function base64(value: unknown, what: string): string {
  const result = text(value, what);
  try {
    atob(result);
  } catch {
    invalid(what);
  }
  return result;
}

function parseContent(value: unknown): ContentBlock {
  const input = object(value, "prompt content");
  const common = commonContent(input);
  switch (input.type) {
    case "text":
      return {
        type: "text",
        text: text(input.text, "text content"),
        ...common,
      };
    case "image":
    case "audio":
      return {
        type: input.type,
        data: base64(input.data, `${input.type} content`),
        mimeType: text(input.mimeType, `${input.type} MIME type`),
        ...common,
      };
    case "resource_link": {
      const title = optionalText(input, "title", "resource link title");
      const description = optionalText(
        input,
        "description",
        "resource link description",
      );
      const mimeType = optionalText(
        input,
        "mimeType",
        "resource link MIME type",
      );
      if (
        input.size !== undefined &&
        (typeof input.size !== "number" || !Number.isFinite(input.size))
      )
        invalid("resource link size");
      return {
        type: "resource_link",
        uri: text(input.uri, "resource link URI"),
        name: text(input.name, "resource link name"),
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(input.size === undefined ? {} : { size: input.size }),
        ...common,
      };
    }
    case "resource": {
      const resource = object(input.resource, "embedded resource");
      const uri = text(resource.uri, "embedded resource URI");
      const mimeType = optionalText(
        resource,
        "mimeType",
        "embedded resource MIME type",
      );
      const resourceMeta = metadata(
        resource,
        "_meta",
        "embedded resource metadata",
      );
      const resourceCommon = {
        uri,
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(resourceMeta === undefined ? {} : { _meta: resourceMeta }),
      };
      if (typeof resource.text === "string") {
        return {
          type: "resource",
          resource: { ...resourceCommon, text: resource.text },
          ...common,
        };
      }
      return {
        type: "resource",
        resource: {
          ...resourceCommon,
          blob: base64(resource.blob, "embedded resource content"),
        },
        ...common,
      };
    }
    default:
      return invalid("prompt content");
  }
}

/** Validate and normalize an unknown `prompts/get` result. */
export function parseGetPromptResult(value: unknown): GetPromptResult {
  if (jsonByteLength(value, "prompts/get result") > MAX_PROMPT_RESULT_BYTES)
    invalid("prompts/get result size");
  const input = object(value, "prompts/get result");
  const description = optionalText(
    input,
    "description",
    "prompts/get description",
  );
  if (
    !Array.isArray(input.messages) ||
    input.messages.length > MAX_PROMPT_MESSAGES
  )
    invalid("prompts/get messages");
  const messages = input.messages.map((value) => {
    const message = object(value, "prompt message");
    if (message.role !== "user" && message.role !== "assistant")
      invalid("prompt message role");
    const role: "user" | "assistant" = message.role;
    return { role, content: parseContent(message.content) };
  });
  return {
    ...(description === undefined ? {} : { description }),
    messages,
  };
}
