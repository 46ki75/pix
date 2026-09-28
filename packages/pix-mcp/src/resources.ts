import { mediaTypeEssence } from "@modelcontextprotocol/sdk/shared/mediaType.js";
import { StdUriTemplate } from "@std-uritemplate/std-uritemplate";
import fastUri from "fast-uri";
import type {
  ContentBlock,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";
import { compact } from "./catalog.ts";
import {
  quoteCommandArgument,
  renderCommandToken,
  tokenizeCommand,
  type CommandToken,
} from "./command.ts";
import { formatContent } from "./output.ts";

export interface DirectResourceEntry {
  kind: "resource";
  server: string;
  resource: Resource;
}

export interface TemplateResourceEntry {
  kind: "template";
  server: string;
  template: ResourceTemplate;
  variables: string[];
}

export type ResourceEntry = DirectResourceEntry | TemplateResourceEntry;
export type ResourceArgumentToken = CommandToken;

export type ResourceCommand =
  | { action: "list"; server?: string }
  | {
      action: "read";
      server: string;
      target: string;
      argumentTokens: ResourceArgumentToken[];
    };

const MAX_IDENTIFIER_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_MIME_TYPE_BYTES = 256;
const MAX_VARIABLES = 100;
const MAX_ANNOTATION_AUDIENCE = 2;
const MAX_EXPANSION_WORK_BYTES = 1024 * 1024;
const templateLiteralCharacters = new Set(
  "!#$&()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz~",
);
const unsafeIdentifier = /[\p{C}\p{Zl}\p{Zp}]/u;
const unsafeTemplateCharacter = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const variableName =
  /^(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})+(?:\.(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})+)*$/u;

function validIdentifier(value: string, maximum = MAX_IDENTIFIER_BYTES) {
  const bytes = Buffer.byteLength(value);
  return bytes > 0 && bytes <= maximum && !unsafeIdentifier.test(value);
}

function validateCommonMetadata(
  item: Pick<
    Resource | ResourceTemplate,
    "name" | "title" | "description" | "mimeType" | "annotations"
  >,
) {
  if (
    !validIdentifier(item.name) ||
    Buffer.byteLength(item.title ?? "") > MAX_METADATA_BYTES ||
    Buffer.byteLength(item.description ?? "") > MAX_METADATA_BYTES ||
    (item.mimeType !== undefined &&
      !validIdentifier(item.mimeType, MAX_MIME_TYPE_BYTES)) ||
    (item.annotations?.audience?.length ?? 0) > MAX_ANNOTATION_AUDIENCE
  )
    throw new Error("Invalid resource metadata");
}

export function validateResourceUri(uri: string): void {
  if (
    !validIdentifier(uri) ||
    !/^[\x21-\x7e]+$/u.test(uri) ||
    /[^A-Za-z0-9._~:/?#\u005b\u005d@!$&'()*+,;=%-]/u.test(uri) ||
    /%(?![0-9A-Fa-f]{2})/u.test(uri) ||
    (uri.match(/#/gu)?.length ?? 0) > 1
  )
    throw new Error("Invalid MCP resource URI.");
  const parsed = fastUri.parse(uri);
  const afterScheme = uri.slice(uri.indexOf(":") + 1);
  const authorityEnd = afterScheme.startsWith("//")
    ? afterScheme.slice(2).search(/[/?#]/u)
    : -1;
  const outsideAuthority = afterScheme.startsWith("//")
    ? authorityEnd < 0
      ? ""
      : afterScheme.slice(authorityEnd + 2)
    : afterScheme;
  if (
    parsed.error ||
    parsed.scheme === undefined ||
    parsed.userinfo !== undefined ||
    outsideAuthority.includes("[") ||
    outsideAuthority.includes("]")
  )
    throw new Error("Invalid MCP resource URI.");
}

function validTemplateUnicode(codePoint: number): boolean {
  return (
    (codePoint >= 0xa0 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfdcf) ||
    (codePoint >= 0xfdf0 && codePoint <= 0xffef) ||
    (codePoint >= 0x1_0000 && codePoint <= 0x1_fffd) ||
    (codePoint >= 0x2_0000 && codePoint <= 0x2_fffd) ||
    (codePoint >= 0x3_0000 && codePoint <= 0x3_fffd) ||
    (codePoint >= 0x4_0000 && codePoint <= 0x4_fffd) ||
    (codePoint >= 0x5_0000 && codePoint <= 0x5_fffd) ||
    (codePoint >= 0x6_0000 && codePoint <= 0x6_fffd) ||
    (codePoint >= 0x7_0000 && codePoint <= 0x7_fffd) ||
    (codePoint >= 0x8_0000 && codePoint <= 0x8_fffd) ||
    (codePoint >= 0x9_0000 && codePoint <= 0x9_fffd) ||
    (codePoint >= 0xa_0000 && codePoint <= 0xa_fffd) ||
    (codePoint >= 0xb_0000 && codePoint <= 0xb_fffd) ||
    (codePoint >= 0xc_0000 && codePoint <= 0xc_fffd) ||
    (codePoint >= 0xd_0000 && codePoint <= 0xd_fffd) ||
    (codePoint >= 0xe_1000 && codePoint <= 0xe_fffd) ||
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf_0000 && codePoint <= 0xf_fffd) ||
    (codePoint >= 0x10_0000 && codePoint <= 0x10_fffd)
  );
}

function validateTemplateLiteral(literal: string): void {
  for (let index = 0; index < literal.length;) {
    const codePoint = literal.codePointAt(index);
    const character =
      codePoint === undefined ? "" : String.fromCodePoint(codePoint);
    if (character === "%") {
      if (!/^[0-9A-Fa-f]{2}$/u.test(literal.slice(index + 1, index + 3)))
        throw new Error("Invalid resource URI template");
      index += 3;
    } else {
      if (
        !character ||
        (!templateLiteralCharacters.has(character) &&
          !validTemplateUnicode(codePoint ?? -1))
      )
        throw new Error("Invalid resource URI template");
      index += character.length;
    }
  }
}

function uriTemplatePrefix(value: string, maximum: number): string {
  let end = 0;
  let count = 0;
  while (end < value.length && count < maximum) {
    if (
      value[end] === "%" &&
      /^[0-9A-Fa-f]{2}$/u.test(value.slice(end + 1, end + 3))
    )
      end += 3;
    else {
      const codePoint = value.codePointAt(end);
      if (codePoint === undefined) break;
      end += String.fromCodePoint(codePoint).length;
    }
    count++;
  }
  return value.slice(0, end);
}

function encodeTemplateValue(value: string, allowReserved: boolean): string {
  let encoded = "";
  for (let index = 0; index < value.length;) {
    if (
      allowReserved &&
      value[index] === "%" &&
      /^[0-9A-Fa-f]{2}$/u.test(value.slice(index + 1, index + 3))
    ) {
      encoded += value.slice(index, index + 3);
      index += 3;
      continue;
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    if (
      /^[A-Za-z0-9._~-]$/u.test(character) ||
      (allowReserved && ":/?#[]@!$&'()*+,;=".includes(character))
    )
      encoded += character;
    else
      encoded += encodeURIComponent(character).replace(
        /[!'()*]/gu,
        (reserved) => `%${reserved.codePointAt(0)?.toString(16).toUpperCase()}`,
      );
    index += character.length;
  }
  return encoded;
}

function expandPrefixedExpression(
  expression: string,
  substitutions: Record<string, string | undefined>,
): string {
  const candidate = expression[1] ?? "";
  const operator = "+#./;?&".includes(candidate) ? candidate : "";
  const body = expression.slice(operator ? 2 : 1, -1);
  const expanded: string[] = [];
  for (let specification of body.split(",")) {
    if (specification.endsWith("*")) specification = specification.slice(0, -1);
    const prefix = specification.match(/:([1-9][0-9]{0,3})$/u);
    const name = prefix
      ? specification.slice(0, -prefix[0].length)
      : specification;
    const original = substitutions[name];
    if (original === undefined) continue;
    const value = prefix?.[1]
      ? uriTemplatePrefix(original, Number(prefix[1]))
      : original;
    const encoded = encodeTemplateValue(
      value,
      operator === "+" || operator === "#",
    );
    if (operator === ";") expanded.push(encoded ? `${name}=${encoded}` : name);
    else if (operator === "?" || operator === "&")
      expanded.push(`${name}=${encoded}`);
    else expanded.push(encoded);
  }
  if (expanded.length === 0) return "";
  const first =
    operator === "#" ||
    operator === "." ||
    operator === "/" ||
    operator === ";" ||
    operator === "?" ||
    operator === "&"
      ? operator
      : "";
  const separator =
    operator === "." || operator === "/" || operator === ";"
      ? operator
      : operator === "?" || operator === "&"
        ? "&"
        : ",";
  return `${first}${expanded.join(separator)}`;
}

function expandUriTemplate(
  template: string,
  substitutions: Record<string, string | undefined>,
): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("{", cursor);
    if (start < 0) {
      parts.push(
        StdUriTemplate.expand(template.slice(cursor), Object.create(null)),
      );
      break;
    }
    parts.push(
      StdUriTemplate.expand(template.slice(cursor, start), Object.create(null)),
    );
    const end = template.indexOf("}", start + 1);
    if (end < 0) throw new Error("Invalid resource URI template");
    const expression = template.slice(start, end + 1);
    const operator = expression[1];
    let expanded = /:[1-9][0-9]{0,3}(?=[,}])/u.test(expression)
      ? expandPrefixedExpression(expression, substitutions)
      : StdUriTemplate.expand(expression, substitutions);
    if (
      operator !== "+" &&
      operator !== "#" &&
      !/:[1-9][0-9]{0,3}(?=[,}])/u.test(expression)
    ) {
      // encodeURIComponent intentionally leaves these reserved characters raw.
      expanded = expanded.replace(
        /[!'()*]/gu,
        (character) =>
          `%${character.codePointAt(0)?.toString(16).toUpperCase()}`,
      );
    }
    parts.push(expanded);
    cursor = end + 1;
  }
  return parts.join("");
}

export function validateResource(resource: Resource): void {
  validateCommonMetadata(resource);
  try {
    validateResourceUri(resource.uri);
  } catch {
    throw new Error("Invalid resource metadata");
  }
  if (
    resource.size !== undefined &&
    (!Number.isSafeInteger(resource.size) || resource.size < 0)
  )
    throw new Error("Invalid resource metadata");
}

export function resourceTemplateVariables(template: string): string[] {
  const templateBytes = Buffer.byteLength(template);
  if (
    templateBytes === 0 ||
    templateBytes > MAX_IDENTIFIER_BYTES ||
    unsafeTemplateCharacter.test(template)
  )
    throw new Error("Invalid resource template metadata");
  const variables: string[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("{", cursor);
    const strayClose = template.indexOf("}", cursor);
    if (start < 0) {
      if (strayClose >= 0) throw new Error("Invalid resource URI template");
      break;
    }
    if (strayClose >= 0 && strayClose < start)
      throw new Error("Invalid resource URI template");
    validateTemplateLiteral(template.slice(cursor, start));
    const end = template.indexOf("}", start + 1);
    if (end < 0 || template.slice(start + 1, end).includes("{"))
      throw new Error("Invalid resource URI template");
    let expression = template.slice(start + 1, end);
    if (/^[+#./;?&]/u.test(expression)) expression = expression.slice(1);
    const specifications = expression.split(",");
    if (specifications.some((specification) => specification.length === 0))
      throw new Error("Invalid resource URI template");
    for (let specification of specifications) {
      if (specification.endsWith("*"))
        specification = specification.slice(0, -1);
      else {
        const prefix = specification.match(/:([1-9][0-9]{0,3})$/u);
        if (prefix) specification = specification.slice(0, -prefix[0].length);
      }
      if (
        !variableName.test(specification) ||
        Buffer.byteLength(specification) > 256
      )
        throw new Error("Invalid resource URI template");
      if (!seen.has(specification)) {
        if (variables.length >= MAX_VARIABLES)
          throw new Error("Resource URI template has too many variables");
        seen.add(specification);
        variables.push(specification);
      }
    }
    cursor = end + 1;
  }
  validateTemplateLiteral(template.slice(cursor));
  try {
    expandUriTemplate(template, Object.create(null));
  } catch {
    throw new Error("Invalid resource URI template");
  }
  return variables;
}

export function validateResourceTemplate(template: ResourceTemplate): string[] {
  validateCommonMetadata(template);
  return resourceTemplateVariables(template.uriTemplate);
}

export function resourceKey(
  server: string,
  kind: ResourceEntry["kind"],
  identifier: string,
): string {
  return JSON.stringify([server, kind, identifier]);
}

export function resourceEntryKey(entry: ResourceEntry): string {
  return resourceKey(
    entry.server,
    entry.kind,
    entry.kind === "resource" ? entry.resource.uri : entry.template.uriTemplate,
  );
}

export function parseResourceCommand(input: string): ResourceCommand {
  const tokens = tokenizeCommand(input, "resource");
  const action = tokens.shift()?.value;
  if (action === "list") {
    if (tokens.length > 1)
      throw new Error("Usage: /mcp-resource list [server]");
    const server = tokens[0]?.value;
    return { action, ...(server ? { server } : {}) };
  }
  if (action === "read") {
    const server = tokens.shift()?.value;
    const target = tokens.shift()?.value;
    if (!server || !target)
      throw new Error(
        "Usage: /mcp-resource read <server> <uri-or-template> [name=value ...]",
      );
    return { action, server, target, argumentTokens: tokens };
  }
  throw new Error(
    "Usage: /mcp-resource list [server] | /mcp-resource read <server> <uri-or-template> [name=value ...]",
  );
}

function expandedUriUpperBound(
  template: string,
  values: Record<string, string>,
): number {
  let bytes = 0;
  let offset = 0;
  for (const match of template.matchAll(/\{[+#./;?&]?([^{}]+)\}/gu)) {
    bytes += Buffer.byteLength(template.slice(offset, match.index));
    offset = match.index + match[0].length;
    for (let specification of match[1]?.split(",") ?? []) {
      let prefixLength: number | undefined;
      if (specification.endsWith("*"))
        specification = specification.slice(0, -1);
      else {
        const prefix = specification.match(/:([1-9][0-9]{0,3})$/u);
        if (prefix?.[1]) {
          prefixLength = Number(prefix[1]);
          specification = specification.slice(0, -prefix[0].length);
        }
      }
      const value = values[specification];
      if (value === undefined) continue;
      const boundedValue =
        prefixLength === undefined
          ? value
          : uriTemplatePrefix(value, prefixLength);
      // encodeURIComponent leaves five RFC 3986 reserved characters unchanged;
      // count them as percent-encoded to bound every RFC 6570 operator.
      const encoded = encodeURIComponent(boundedValue).replace(
        /[!'()*]/gu,
        "xxx",
      );
      bytes += encoded.length + Buffer.byteLength(specification) * 3 + 16;
      if (bytes > MAX_EXPANSION_WORK_BYTES) return bytes;
    }
  }
  return bytes + Buffer.byteLength(template.slice(offset));
}

export function resolveResourceUri(
  target: string,
  template: TemplateResourceEntry | undefined,
  tokens: (ResourceArgumentToken | string)[],
): string {
  if (!template) {
    if (tokens.length > 0)
      throw new Error(
        "Resource arguments require an exact URI template from the catalog.",
      );
    validateResourceUri(target);
    return target;
  }

  const declared = new Set(template.variables);
  const named = new Map<string, string>();
  const positional: string[] = [];
  for (const token of tokens) {
    const value = typeof token === "string" ? token : token.value;
    const separator =
      typeof token === "string" ? token.indexOf("=") : token.separator;
    const candidate = value.slice(0, separator);
    if (separator !== undefined && separator > 0 && declared.has(candidate)) {
      if (named.has(candidate))
        throw new Error(
          `Resource template variable ${candidate} was provided more than once.`,
        );
      named.set(candidate, value.slice(separator + 1));
    } else positional.push(value);
  }

  const values = Object.create(null) as Record<string, string>;
  let position = 0;
  for (const name of template.variables) {
    const namedValue = named.get(name);
    const value = namedValue ?? positional[position];
    if (namedValue === undefined && value !== undefined) position++;
    if (value !== undefined) values[name] = value;
    named.delete(name);
  }
  if (position < positional.length)
    throw new Error("Too many positional resource arguments were provided.");
  if (Buffer.byteLength(JSON.stringify(values)) > 256 * 1024)
    throw new Error("MCP resource template arguments exceed 256 KiB.");
  try {
    // This loose preflight bounds allocation amplification from repeated
    // variables; the exact 16 KiB result limit is enforced after expansion.
    if (
      expandedUriUpperBound(template.template.uriTemplate, values) >
      MAX_EXPANSION_WORK_BYTES
    )
      throw new Error();
  } catch {
    throw new Error("Expanded MCP resource URI exceeds 16 KiB.");
  }

  let uri: string;
  try {
    uri = expandUriTemplate(template.template.uriTemplate, values);
  } catch {
    throw new Error("Could not expand the MCP resource URI template.");
  }
  if (Buffer.byteLength(uri) > MAX_IDENTIFIER_BYTES)
    throw new Error("Expanded MCP resource URI exceeds 16 KiB.");
  try {
    validateResourceUri(uri);
  } catch {
    throw new Error("Expanded MCP resource URI is invalid.");
  }
  return uri;
}

function entryTarget(entry: ResourceEntry): string {
  return entry.kind === "resource"
    ? entry.resource.uri
    : entry.template.uriTemplate;
}

function entryMetadata(entry: ResourceEntry) {
  return entry.kind === "resource" ? entry.resource : entry.template;
}

export function formatResourceList(
  entries: ResourceEntry[],
  server?: string,
): string {
  const selected = entries
    .filter((entry) => !server || entry.server === server)
    .sort(
      (a, b) =>
        a.server.localeCompare(b.server, "en") ||
        entryTarget(a).localeCompare(entryTarget(b), "en") ||
        a.kind.localeCompare(b.kind, "en"),
    );
  if (selected.length === 0)
    return server
      ? `No MCP resources are available from ${server}.`
      : "No MCP resources are available.";
  const lines = ["Available MCP resources:"];
  let shown = 0;
  for (const entry of selected) {
    const metadata = entryMetadata(entry);
    const description = compact(
      metadata.description ?? metadata.title ?? metadata.name,
      160,
    );
    const variables =
      entry.kind === "template" && entry.variables.length > 0
        ? ` ${entry.variables.map((name) => `[${quoteCommandArgument(name)}]`).join(" ")}`
        : "";
    const line = `${entry.server} ${entry.kind} ${quoteCommandArgument(entryTarget(entry))}${variables}${description ? ` — ${description}` : ""}`;
    if (shown >= 100 || lines.join("\n").length + line.length > 15_000) {
      lines.push(`${selected.length - shown} additional resources omitted.`);
      break;
    }
    lines.push(line);
    shown++;
  }
  lines.push(
    "Read one with /mcp-resource read <server> <uri-or-template> [name=value ...].",
  );
  return lines.join("\n");
}

function completionItems(values: string[], prefix: string) {
  return values.map((value) => ({
    value: `${prefix}${quoteCommandArgument(value)}`,
    label: value,
  }));
}

export function resourceCompletions(
  prefix: string,
  entries: ResourceEntry[],
  configuredServers: Iterable<string> = [],
): { value: string; label: string; description?: string }[] | null {
  const trailingSpace = /\s$/u.test(prefix);
  let tokens: ResourceArgumentToken[];
  try {
    tokens = tokenizeCommand(prefix);
  } catch {
    return null;
  }
  if (tokens.length === 0)
    return [
      { value: "list", label: "list", description: "List MCP resources" },
      { value: "read", label: "read", description: "Read an MCP resource" },
    ];
  if (tokens.length === 1 && !trailingSpace)
    return ["list", "read"]
      .filter((action) => action.startsWith(tokens[0]?.value ?? ""))
      .map((action) => ({ value: action, label: action }));
  const action = tokens[0]?.value;
  if (action !== "list" && action !== "read") return null;
  const servers = [
    ...new Set([...configuredServers, ...entries.map((entry) => entry.server)]),
  ].sort();
  if (tokens.length === 1 || (tokens.length === 2 && !trailingSpace)) {
    const current = trailingSpace ? "" : (tokens[1]?.value ?? "");
    return completionItems(
      servers.filter((server) => server.startsWith(current)),
      `${action} `,
    );
  }
  if (action === "list") return null;
  const server = tokens[1]?.value;
  if (!server || !servers.includes(server)) return null;
  if (
    (tokens.length === 2 && trailingSpace) ||
    (tokens.length === 3 && !trailingSpace)
  ) {
    const current = trailingSpace ? "" : (tokens[2]?.value ?? "");
    return entries
      .filter(
        (entry) =>
          entry.server === server && entryTarget(entry).startsWith(current),
      )
      .sort((a, b) => entryTarget(a).localeCompare(entryTarget(b), "en"))
      .map((entry) => {
        const metadata = entryMetadata(entry);
        return {
          value: `read ${quoteCommandArgument(server)} ${quoteCommandArgument(entryTarget(entry))}`,
          label: compact(entryTarget(entry), 180),
          ...(metadata.description || metadata.title
            ? {
                description: compact(
                  metadata.description ?? metadata.title ?? "",
                  100,
                ),
              }
            : {}),
        };
      });
  }
  const target = tokens[2]?.value;
  if (!target) return null;
  const template = entries.find(
    (entry): entry is TemplateResourceEntry =>
      entry.kind === "template" &&
      entry.server === server &&
      entry.template.uriTemplate === target,
  );
  if (!template) return null;
  const supplied = tokens.slice(3);
  const currentToken = trailingSpace ? undefined : supplied.pop();
  const current = currentToken?.value ?? "";
  if (currentToken?.separator !== undefined) return null;
  const named = new Set<string>();
  let positional = 0;
  for (const token of supplied) {
    const candidate = token.value.slice(0, token.separator);
    if (
      token.separator !== undefined &&
      token.separator > 0 &&
      template.variables.includes(candidate)
    )
      named.add(candidate);
    else positional++;
  }
  const satisfied = new Set<string>();
  let position = 0;
  for (const name of template.variables) {
    if (named.has(name)) satisfied.add(name);
    else if (position < positional) {
      satisfied.add(name);
      position++;
    }
  }
  const base = [
    "read",
    quoteCommandArgument(server),
    quoteCommandArgument(target),
    ...supplied.map(renderCommandToken),
  ].join(" ");
  const variables = template.variables.filter(
    (name) => !satisfied.has(name) && name.startsWith(current),
  );
  return variables.length > 0
    ? variables.map((name) => ({
        value: `${base} ${quoteCommandArgument(name)}=`,
        label: `${name}=`,
      }))
    : null;
}

function sanitizeResourceText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    )
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "");
}

function resourceArtifact(result: ReadResourceResult): ReadResourceResult {
  const artifact = {
    ...result,
    contents: result.contents.map((content) => ({ ...content })),
  };
  delete artifact._meta;
  for (const content of artifact.contents) delete content._meta;
  return artifact;
}

export async function formatResourceResult(
  server: string,
  result: ReadResourceResult,
) {
  if (result.contents.length === 0)
    throw new Error("MCP resource returned no content.");
  if (result.contents.length > 100)
    throw new Error("MCP resource returned too many content items.");
  if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024 * 1024)
    throw new Error("MCP resource result exceeds 16 MiB.");

  const artifact = resourceArtifact(result);
  const blocks: ContentBlock[] = [];
  let sanitized = false;
  for (const content of artifact.contents) {
    try {
      validateResourceUri(content.uri);
    } catch {
      throw new Error("MCP resource returned invalid metadata.");
    }
    if (
      content.mimeType !== undefined &&
      !validIdentifier(content.mimeType, MAX_MIME_TYPE_BYTES)
    )
      throw new Error("MCP resource returned invalid metadata.");
    const marker = `[MCP resource ${JSON.stringify({
      server,
      uri: content.uri,
      ...(content.mimeType ? { mimeType: content.mimeType } : {}),
    })}]`;
    blocks.push({ type: "text", text: marker });
    if ("text" in content) {
      const text = sanitizeResourceText(content.text);
      if (text !== content.text) sanitized = true;
      blocks.push({ type: "text", text });
    } else {
      const mimeType = mediaTypeEssence(content.mimeType);
      if (
        mimeType &&
        ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          mimeType,
        )
      ) {
        blocks.push({
          type: "image",
          data: content.blob,
          mimeType,
        });
      } else blocks.push({ type: "resource", resource: content });
    }
  }
  return formatContent(blocks, {
    artifact,
    preserveOrder: true,
    artifactRequired: sanitized,
  });
}
