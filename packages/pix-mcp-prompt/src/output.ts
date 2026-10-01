import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ContentBlock } from "@earendil-works/pi-mcp";

export const MAX_TEXT_BYTES = 24 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 4;

export async function formatContent(
  blocks: ContentBlock[],
  options: { artifact: unknown },
) {
  const ordered: (TextContent | ImageContent)[] = [];
  let images = 0;
  let omitted = false;
  for (const block of blocks) {
    if (block.type === "text") ordered.push({ type: "text", text: block.text });
    else if (
      block.type === "image" &&
      images < MAX_IMAGES &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        block.mimeType,
      ) &&
      Buffer.byteLength(block.data, "base64") <= MAX_IMAGE_BYTES
    ) {
      images++;
      ordered.push({
        type: "image",
        mimeType: block.mimeType,
        data: block.data,
      });
    } else {
      ordered.push({
        type: "text",
        text: `[MCP ${block.type} content omitted; see full result.]`,
      });
      omitted = true;
    }
  }
  const fullText = ordered
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
  // Decode only complete UTF-8 characters at the byte boundary.
  const bounded = Buffer.from(fullText)
    .subarray(0, MAX_TEXT_BYTES)
    .toString("utf8")
    .replace(/\uFFFD$/, "")
    .split("\n")
    .slice(0, 1000)
    .join("\n");
  const truncated = omitted || bounded !== fullText;
  let directory: string | undefined;
  let fullOutputPath: string | undefined;
  const cleanup = async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  };
  if (truncated) {
    directory = await mkdtemp(join(tmpdir(), "pix-mcp-prompt-"));
    fullOutputPath = join(directory, "result.json");
    try {
      await writeFile(
        fullOutputPath,
        JSON.stringify(options.artifact, null, 2),
        { mode: 0o600 },
      );
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
  const content: (TextContent | ImageContent)[] = [];
  let offset = 0;
  let textIndex = 0;
  for (const block of ordered) {
    if (block.type === "image") {
      if (bounded === fullText || offset < bounded.length) content.push(block);
      continue;
    }
    const value = `${textIndex++ > 0 ? "\n\n" : ""}${block.text}`;
    const visible = bounded.slice(offset, offset + value.length);
    offset += value.length;
    if (!visible) continue;
    const previous = content.at(-1);
    if (previous?.type === "text") previous.text += visible;
    else content.push({ type: "text", text: visible });
  }
  if (fullOutputPath)
    content.push({
      type: "text",
      text: `\n\nFull MCP result: ${fullOutputPath}\nUse read with offset/limit to inspect it.`,
    });
  return {
    content,
    details: { truncated, ...(fullOutputPath ? { fullOutputPath } : {}) },
    cleanup,
  };
}

function createEditableContentGuard(): string {
  const bytes = randomBytes(8);
  let guard = "\u2060\u2063";
  for (const byte of bytes)
    for (let bit = 7; bit >= 0; bit--)
      guard += byte & (1 << bit) ? "\u2063" : "\u2060";
  return guard;
}

export function removeEditablePromptGuard(text: string, guard: string): string {
  return text.replaceAll(guard, "");
}

function prepareEditableContent(text: string): {
  text: string;
  guard?: string;
} {
  // The TUI interprets leading / and ! as commands. A session-owned invisible
  // guard keeps server text inert through command dispatch until message_end.
  const sanitized = text
    .replace(/\r\n?/gu, "\n")
    .replace(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    )
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "");
  if (!/^[!/]/u.test(sanitized.trimStart())) return { text: sanitized };
  const guard = createEditableContentGuard();
  return { text: `${guard}${sanitized}`, guard };
}

const imageExtensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export async function formatEditableContent(
  content: (TextContent | ImageContent)[],
): Promise<{ text: string; guard?: string; cleanup: () => Promise<void> }> {
  let text = "";
  let imageDirectory: string | undefined;
  let imageIndex = 0;
  try {
    for (const block of content) {
      if (block.type === "text") {
        text += block.text;
        continue;
      }
      imageDirectory ??= await mkdtemp(join(tmpdir(), "pix-mcp-prompt-draft-"));
      const extension = imageExtensions[block.mimeType] ?? "img";
      const path = join(imageDirectory, `image-${++imageIndex}.${extension}`);
      await writeFile(path, Buffer.from(block.data, "base64"), { mode: 0o600 });
      const separator = text.endsWith("\n\n")
        ? ""
        : text.endsWith("\n")
          ? "\n"
          : "\n\n";
      text += `${separator}@${JSON.stringify(path.replaceAll("\\", "/"))}`;
    }
  } catch (error) {
    if (imageDirectory)
      await rm(imageDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    ...prepareEditableContent(text),
    cleanup: async () => {
      if (imageDirectory)
        await rm(imageDirectory, { recursive: true, force: true });
    },
  };
}
