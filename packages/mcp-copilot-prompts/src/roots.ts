import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_NAME_BYTES, MAX_ROOTS } from "./limits.js";
import type { PromptRoot } from "./types.js";
import { byteLength, compareText, hasUnsafeText } from "./util.js";

export interface RootInput {
  path: string;
  label?: string;
}

export async function canonicalizeRoot(input: RootInput): Promise<PromptRoot> {
  const path = await realpath(resolve(input.path));
  const information = await stat(path);
  if (!information.isDirectory()) {
    throw new Error(`prompt root is not a directory: ${input.path}`);
  }
  const candidate = input.label?.trim();
  const label =
    candidate &&
    byteLength(candidate) <= MAX_NAME_BYTES &&
    !hasUnsafeText(candidate)
      ? candidate
      : basename(path) || "root";
  return { path, label };
}

export async function canonicalizeRoots(
  inputs: RootInput[],
): Promise<PromptRoot[]> {
  if (inputs.length > MAX_ROOTS) {
    throw new Error(`more than ${MAX_ROOTS} prompt roots were provided`);
  }
  const roots = await Promise.all(inputs.map(canonicalizeRoot));
  const unique = new Map<string, PromptRoot>();
  for (const root of roots) {
    if (!unique.has(root.path)) unique.set(root.path, root);
  }
  return [...unique.values()].sort((left, right) =>
    compareText(left.path, right.path),
  );
}

export async function rootsFromMcp(
  roots: { uri: string; name?: string | undefined }[],
): Promise<PromptRoot[]> {
  const inputs: RootInput[] = [];
  for (const root of roots.slice(0, MAX_ROOTS)) {
    let url: URL;
    try {
      url = new URL(root.uri);
    } catch {
      continue;
    }
    if (url.protocol !== "file:" || url.search || url.hash) continue;
    try {
      inputs.push({
        path: fileURLToPath(url),
        ...(root.name === undefined ? {} : { label: root.name }),
      });
    } catch {
      // Ignore roots that cannot be represented on this platform.
    }
  }
  const settled = await Promise.allSettled(inputs.map(canonicalizeRoot));
  return settled
    .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
    .filter(
      (root, index, all) =>
        all.findIndex((candidate) => candidate.path === root.path) === index,
    )
    .sort((left, right) => compareText(left.path, right.path));
}
