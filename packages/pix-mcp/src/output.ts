import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  CallToolResult,
  ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";

export const MAX_TEXT_BYTES = 24 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_DETAILS_BYTES = 16 * 1024;

function preview(text: string): string {
  // Decode only complete UTF-8 characters at the byte boundary.
  return Buffer.from(text)
    .subarray(0, MAX_TEXT_BYTES)
    .toString("utf8")
    .replace(/\uFFFD$/, "")
    .split("\n")
    .slice(0, 1000)
    .join("\n");
}

interface ContentOptions {
  artifact: unknown;
  structuredContent?: unknown;
  preserveErrorImages?: boolean;
  preserveOrder?: boolean;
}

export async function formatContent(
  blocks: ContentBlock[],
  options: ContentOptions,
) {
  const text: string[] = [];
  const images: ImageContent[] = [];
  const ordered: (TextContent | ImageContent)[] = [];
  const addText = (value: string) => {
    text.push(value);
    ordered.push({ type: "text", text: value });
  };
  let omitted = false;
  for (const block of blocks) {
    if (block.type === "text") addText(block.text);
    else if (
      block.type === "image" &&
      images.length < MAX_IMAGES &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        block.mimeType,
      ) &&
      // Padding can give three decoded sizes the same encoded length.
      Buffer.byteLength(block.data, "base64") <= MAX_IMAGE_BYTES
    ) {
      const image: ImageContent = {
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      };
      images.push(image);
      ordered.push(image);
    } else {
      addText(`[MCP ${block.type} content omitted; see full result.]`);
      omitted = true;
    }
  }
  if (options.structuredContent !== undefined) {
    addText(
      `Structured content:\n${JSON.stringify(options.structuredContent)}`,
    );
  }
  const fullText = text.join("\n\n") || "(No text output)";
  const bounded = preview(fullText);
  const structured = options.structuredContent;
  const largeDetails =
    structured !== undefined &&
    Buffer.byteLength(JSON.stringify(structured)) > MAX_DETAILS_BYTES;
  const truncated =
    bounded !== fullText ||
    omitted ||
    largeDetails ||
    (options.preserveErrorImages === true && images.length > 0);
  let fullOutputPath: string | undefined;
  if (truncated) {
    const directory = await mkdtemp(join(tmpdir(), "pix-mcp-"));
    fullOutputPath = join(directory, "result.json");
    await writeFile(fullOutputPath, JSON.stringify(options.artifact, null, 2), {
      mode: 0o600,
    });
  }
  const artifactNotice = fullOutputPath
    ? `Full MCP result: ${fullOutputPath}\nUse read with offset/limit to inspect it.`
    : undefined;
  let content: (TextContent | ImageContent)[];
  if (options.preserveOrder) {
    content = [];
    let offset = 0;
    let textIndex = 0;
    for (const block of ordered) {
      if (block.type === "image") {
        content.push(block);
        continue;
      }
      const value = `${textIndex++ > 0 ? "\n\n" : ""}${block.text}`;
      // Slice the already byte/line-bounded preview itself; value supplies only
      // the original block boundary needed to preserve image ordering.
      const visible = bounded.slice(offset, offset + value.length);
      offset += visible.length;
      if (!visible) continue;
      const previous = content.at(-1);
      if (previous?.type === "text") previous.text += visible;
      else content.push({ type: "text", text: visible });
    }
    if (textIndex === 0) content.unshift({ type: "text", text: bounded });
    if (artifactNotice)
      content.push({ type: "text", text: `\n\n${artifactNotice}` });
  } else {
    content = [
      {
        type: "text",
        text: bounded + (artifactNotice ? `\n\n${artifactNotice}` : ""),
      },
      ...images,
    ];
  }
  return {
    content,
    details: {
      truncated,
      ...(fullOutputPath ? { fullOutputPath } : {}),
      ...(structured !== undefined && !largeDetails
        ? { structuredContent: structured }
        : {}),
      ...(largeDetails ? { structuredContentOmitted: true } : {}),
    },
  };
}

const imageExtensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export async function formatEditableContent(
  content: (TextContent | ImageContent)[],
): Promise<{ text: string; cleanup: () => Promise<void> }> {
  let text = "";
  let imageDirectory: string | undefined;
  let imageIndex = 0;
  try {
    for (const block of content) {
      if (block.type === "text") {
        text += block.text;
        continue;
      }
      imageDirectory ??= await mkdtemp(join(tmpdir(), "pix-mcp-prompt-"));
      const extension = imageExtensions[block.mimeType] ?? "img";
      const path = join(
        imageDirectory,
        `prompt-image-${++imageIndex}.${extension}`,
      );
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
    text,
    cleanup: async () => {
      if (imageDirectory)
        await rm(imageDirectory, { recursive: true, force: true });
    },
  };
}

export function formatResult(result: CallToolResult) {
  // Pi 0.87 turns thrown tool errors into text only. Preserve error images in
  // the full-result artifact before the native execution wrapper throws.
  return formatContent(result.content, {
    artifact: result,
    structuredContent: result.structuredContent,
    preserveErrorImages: result.isError === true,
  });
}
