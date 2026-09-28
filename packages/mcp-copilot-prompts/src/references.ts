import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import type { PromptMessage } from "@modelcontextprotocol/sdk/types.js";
import { lexer, walkTokens } from "marked";
import {
  MAX_REFERENCE_BYTES,
  MAX_REFERENCES,
  MAX_TOTAL_REFERENCE_BYTES,
} from "./limits.js";
import { readContainedFile, SafeFileError } from "./safe-file.js";
import type { PortablePrompt } from "./types.js";
import { sanitizeInline } from "./util.js";

// Copilot accepts escaped spaces in inline destinations even though CommonMark
// parsers generally require angle brackets around destinations with spaces.
const COPILOT_MARKDOWN_LINK =
  /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\s()])+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu;
const FILE_REFERENCE =
  /(?<![\p{L}\p{N}_\\])#file:(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|<([^>\n]+)>|((?:(?:\$\{(?:workspaceFolder|workspaceFolderBasename)\})|[^\s)\]}>;,])+))/gu;
const URI_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/u;

export class PromptReferenceError extends Error {}

function decodeMarkdownReference(value: string): string {
  const withoutFragment = value.split("#", 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    throw new PromptReferenceError(
      `invalid percent encoding in reference ${JSON.stringify(sanitizeInline(value))}`,
    );
  }
  return decoded.replace(/\\([\\ ()])/gu, "$1");
}

interface ExtractedReference {
  kind: "file" | "markdown";
  value: string;
}

function extractReferences(body: string): ExtractedReference[] {
  const references: ExtractedReference[] = [];
  const linkDescendants = new WeakSet<object>();
  walkTokens(lexer(body), (token) => {
    if (linkDescendants.has(token)) return;
    if (token.type === "link" || token.type === "image") {
      references.push({ kind: "markdown", value: token.href });
      if (token.type === "link" && token.tokens) {
        walkTokens(token.tokens, (descendant) => {
          linkDescendants.add(descendant);
        });
      }
      return;
    }
    if (token.type !== "text" || token.tokens !== undefined) return;
    for (const match of token.raw.matchAll(COPILOT_MARKDOWN_LINK)) {
      const value = match[1] ?? match[2];
      if (value !== undefined) {
        references.push({ kind: "markdown", value });
      }
    }
    for (const match of token.raw.matchAll(FILE_REFERENCE)) {
      const value = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (value !== undefined) {
        const unescaped = value.replace(/\\([\\"'])/gu, "$1");
        // Sentence punctuation terminates unquoted chat references. Quoting is
        // required when one of these characters is part of the filename.
        const path =
          match[4] === undefined
            ? unescaped
            : unescaped.replace(/[.:!?]+$/u, "");
        references.push({ kind: "file", value: path });
      }
    }
  });
  return references;
}

function imageMimeType(
  contents: Buffer,
  extension: string,
): string | undefined {
  if (
    extension === ".png" &&
    contents.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    return "image/png";
  }
  if (
    (extension === ".jpg" || extension === ".jpeg") &&
    contents[0] === 0xff &&
    contents[1] === 0xd8 &&
    contents[2] === 0xff
  ) {
    return "image/jpeg";
  }
  const header = contents.subarray(0, 6).toString("ascii");
  if (extension === ".gif" && (header === "GIF87a" || header === "GIF89a")) {
    return "image/gif";
  }
  if (
    extension === ".webp" &&
    contents.subarray(0, 4).toString("ascii") === "RIFF" &&
    contents.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function textMimeType(extension: string): string {
  switch (extension) {
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".html":
    case ".htm":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript";
    default:
      return "text/plain";
  }
}

async function resolveReference(
  value: string,
  prompt: PortablePrompt,
  allowHomeReferences: boolean,
): Promise<{ boundary: string; path: string }> {
  const workspacePath = "$" + "{workspaceFolder}";
  const workspaceName = "$" + "{workspaceFolderBasename}";
  const usesWorkspacePath = value.includes(workspacePath);
  const expanded = value
    .replaceAll(workspacePath, prompt.rootPath)
    .replaceAll(workspaceName, basename(prompt.rootPath));
  if (expanded.includes("${")) {
    throw new PromptReferenceError(
      "input and editor variables in file reference paths are unsupported",
    );
  }
  if (
    expanded === "" ||
    expanded.startsWith("#") ||
    (URI_SCHEME.test(value) && !isAbsolute(value))
  ) {
    throw new PromptReferenceError("not-local");
  }
  if (isAbsolute(expanded) && !usesWorkspacePath) {
    throw new PromptReferenceError("absolute file references are unsupported");
  }

  let candidate: string;
  let boundary: string;
  if (isAbsolute(expanded)) {
    boundary = prompt.rootPath;
    candidate = expanded;
  } else if (expanded === "~" || expanded.startsWith("~/")) {
    if (!allowHomeReferences) {
      throw new PromptReferenceError(
        "home-directory references require --allow-home-references",
      );
    }
    boundary = await realpath(homedir());
    candidate = expanded === "~" ? boundary : join(boundary, expanded.slice(2));
  } else {
    boundary = prompt.rootPath;
    candidate = resolve(dirname(prompt.sourcePath), expanded);
  }

  return { boundary, path: candidate };
}

export interface ReferenceOptions {
  allowHomeReferences: boolean;
}

export async function loadReferenceMessages(
  prompt: PortablePrompt,
  options: ReferenceOptions,
): Promise<PromptMessage[]> {
  const references = extractReferences(prompt.body);
  const localReferences = references.filter(
    ({ value }) =>
      value !== "" &&
      !value.startsWith("#") &&
      !value.startsWith("//") &&
      (!URI_SCHEME.test(value) || isAbsolute(value)),
  );
  if (localReferences.length > MAX_REFERENCES) {
    throw new PromptReferenceError(
      `prompt contains more than ${MAX_REFERENCES} local file references`,
    );
  }

  const seen = new Set<string>();
  const messages: PromptMessage[] = [];
  let totalBytes = 0;
  for (const reference of localReferences) {
    const rawValue = reference.value;
    const value =
      reference.kind === "markdown"
        ? decodeMarkdownReference(rawValue)
        : rawValue;
    let resolved;
    try {
      resolved = await resolveReference(
        value,
        prompt,
        options.allowHomeReferences,
      );
    } catch (error) {
      if (
        error instanceof PromptReferenceError &&
        error.message === "not-local"
      ) {
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new PromptReferenceError(
        `${message}: ${JSON.stringify(sanitizeInline(rawValue))}`,
      );
    }
    let file;
    try {
      file = await readContainedFile(
        resolved.path,
        resolved.boundary,
        MAX_REFERENCE_BYTES,
      );
    } catch (error) {
      if (!(error instanceof SafeFileError)) throw error;
      let message: string;
      switch (error.reason) {
        case "missing":
          message = "referenced file does not exist";
          break;
        case "outside":
          message = "referenced file resolves outside its allowed root";
          break;
        case "not-file":
          message = "referenced path is not a file";
          break;
        case "too-large":
          message = `referenced file exceeds ${MAX_REFERENCE_BYTES} bytes`;
          break;
        case "unreadable":
          message = "referenced file is unreadable";
          break;
      }
      throw new PromptReferenceError(
        `${message}: ${JSON.stringify(sanitizeInline(rawValue))}`,
      );
    }
    if (seen.has(file.path)) continue;
    seen.add(file.path);

    const { contents, information } = file;
    totalBytes += contents.byteLength;
    if (totalBytes > MAX_TOTAL_REFERENCE_BYTES) {
      throw new PromptReferenceError(
        `referenced files exceed ${MAX_TOTAL_REFERENCE_BYTES} total bytes`,
      );
    }

    const extension = extname(file.path).toLowerCase();
    const mimeType = imageMimeType(contents, extension);
    const uri = pathToFileURL(file.path).href;
    const annotations = { lastModified: information.mtime.toISOString() };
    if (mimeType) {
      messages.push({
        role: "user",
        content: {
          type: "resource",
          resource: { uri, mimeType, blob: contents.toString("base64") },
          annotations,
        },
      });
      continue;
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } catch {
      throw new PromptReferenceError(
        `referenced file is neither UTF-8 text nor a supported image: ${JSON.stringify(sanitizeInline(rawValue))}`,
      );
    }
    if (text.includes("\0")) {
      throw new PromptReferenceError(
        `referenced file contains binary data: ${JSON.stringify(sanitizeInline(rawValue))}`,
      );
    }
    messages.push({
      role: "user",
      content: {
        type: "resource",
        resource: { uri, mimeType: textMimeType(extension), text },
        annotations,
      },
    });
  }
  return messages;
}
