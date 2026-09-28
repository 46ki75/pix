import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_TEXT_GLOBAL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function hasUnsafeText(value: string): boolean {
  return UNSAFE_TEXT.test(value);
}

export function sanitizeInline(value: string, maxLength = 200): string {
  const safe = value.replace(UNSAFE_TEXT_GLOBAL, "�");
  return safe.length <= maxLength ? safe : `${safe.slice(0, maxLength - 1)}…`;
}

export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const child = relative(resolve(rootPath), resolve(candidatePath));
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
