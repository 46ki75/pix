import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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

export async function formatResult(result: CallToolResult) {
  const text: string[] = [];
  const images: ImageContent[] = [];
  let omitted = false;
  for (const block of result.content) {
    if (block.type === "text") text.push(block.text);
    else if (
      block.type === "image" &&
      images.length < MAX_IMAGES &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        block.mimeType,
      ) &&
      // Padding can give three decoded sizes the same encoded length.
      Buffer.byteLength(block.data, "base64") <= MAX_IMAGE_BYTES
    ) {
      images.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
    } else {
      text.push(`[MCP ${block.type} content omitted; see full result.]`);
      omitted = true;
    }
  }
  if (result.structuredContent !== undefined) {
    text.push(
      `Structured content:\n${JSON.stringify(result.structuredContent)}`,
    );
  }
  const fullText = text.join("\n\n") || "(No text output)";
  const bounded = preview(fullText);
  const structured = result.structuredContent;
  const largeDetails =
    structured !== undefined &&
    Buffer.byteLength(JSON.stringify(structured)) > MAX_DETAILS_BYTES;
  // Pi 0.87 turns thrown tool errors into text only. Preserve error images in
  // the full-result artifact before the native execution wrapper throws.
  const truncated =
    bounded !== fullText ||
    omitted ||
    largeDetails ||
    (result.isError === true && images.length > 0);
  let fullOutputPath: string | undefined;
  if (truncated) {
    const directory = await mkdtemp(join(tmpdir(), "pix-mcp-"));
    fullOutputPath = join(directory, "result.json");
    await writeFile(fullOutputPath, JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
  }
  const content: (TextContent | ImageContent)[] = [
    {
      type: "text",
      text:
        bounded +
        (fullOutputPath
          ? `\n\nFull MCP result: ${fullOutputPath}\nUse read with offset/limit to inspect it.`
          : ""),
    },
    ...images,
  ];
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
