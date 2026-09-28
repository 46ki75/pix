import { opendir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  MAX_DIAGNOSTICS,
  MAX_NAME_BYTES,
  MAX_PROMPT_FILE_BYTES,
  MAX_PROMPTS,
} from "./limits.js";
import { parsePromptFile } from "./parser.js";
import { readContainedFile, SafeFileError } from "./safe-file.js";
import type {
  CatalogPrompt,
  Diagnostic,
  PortablePrompt,
  PromptRoot,
} from "./types.js";
import {
  byteLength,
  compareText,
  hasUnsafeText,
  isPathWithin,
  sanitizeInline,
  sha256,
  truncateUtf8,
} from "./util.js";

const PROMPT_SUFFIX = ".prompt.md";

export interface DiscoveryResult {
  signature: string;
  prompts: CatalogPrompt[];
  diagnostics: Diagnostic[];
  watchDirectories: string[];
  watchFiles: string[];
}

function diagnosticPath(root: PromptRoot, path: string): string {
  const child = relative(root.path, path);
  return child === "" ? "." : child;
}

function addDiagnostic(
  diagnostics: Diagnostic[],
  root: PromptRoot,
  path: string,
  error: unknown,
): void {
  if (diagnostics.length >= MAX_DIAGNOSTICS) return;
  const message = error instanceof Error ? error.message : String(error);
  diagnostics.push({
    path: diagnosticPath(root, path),
    message: sanitizeInline(message),
  });
}

interface RootDiscovery {
  prompts: PortablePrompt[];
  candidates: number;
  watchDirectories: string[];
  watchFiles: string[];
}

async function containedProspectivePath(
  path: string,
  rootPath: string,
  symlinkDepth = 0,
): Promise<string | undefined> {
  if (symlinkDepth > 40 || !isPathWithin(rootPath, path)) return undefined;
  let current = path;
  const missingSegments: string[] = [];
  while (isPathWithin(rootPath, current)) {
    try {
      const canonical = await realpath(current);
      if (!isPathWithin(rootPath, canonical)) return undefined;
      const prospective = resolve(canonical, ...missingSegments);
      return isPathWithin(rootPath, prospective) ? prospective : undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
    }
    try {
      const canonicalParent = await realpath(dirname(current));
      if (!isPathWithin(rootPath, canonicalParent)) return undefined;
      const target = resolve(
        canonicalParent,
        await readlink(current),
        ...missingSegments,
      );
      return containedProspectivePath(target, rootPath, symlinkDepth + 1);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EINVAL") {
        return undefined;
      }
    }
    if (current === rootPath) break;
    missingSegments.unshift(basename(current));
    current = dirname(current);
  }
  return undefined;
}

function retainCandidate(names: string[], name: string, limit: number): void {
  let low = 0;
  let high = names.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareText(names[middle] ?? "", name) < 0) low = middle + 1;
    else high = middle;
  }
  names.splice(low, 0, name);
  if (names.length > limit) names.pop();
}

async function discoverRoot(
  root: PromptRoot,
  diagnostics: Diagnostic[],
  maxCandidates: number,
): Promise<RootDiscovery> {
  const configuredDirectory = join(root.path, ".github", "prompts");
  let directory: string;
  try {
    directory = await realpath(configuredDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const target = await containedProspectivePath(
        configuredDirectory,
        root.path,
      );
      return {
        prompts: [],
        candidates: 0,
        watchDirectories: target ? [target] : [],
        watchFiles: [],
      };
    }
    addDiagnostic(diagnostics, root, configuredDirectory, error);
    return {
      prompts: [],
      candidates: 0,
      watchDirectories: [],
      watchFiles: [],
    };
  }
  if (!isPathWithin(root.path, directory)) {
    addDiagnostic(
      diagnostics,
      root,
      configuredDirectory,
      new Error("prompt directory resolves outside the configured root"),
    );
    return {
      prompts: [],
      candidates: 0,
      watchDirectories: [],
      watchFiles: [],
    };
  }

  const selectedNames: string[] = [];
  let candidateLimitExceeded = false;
  try {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (
        (!entry.isFile() && !entry.isSymbolicLink()) ||
        !entry.name.endsWith(PROMPT_SUFFIX)
      ) {
        continue;
      }
      if (selectedNames.length >= maxCandidates) {
        candidateLimitExceeded = true;
        if (
          maxCandidates === 0 ||
          compareText(entry.name, selectedNames.at(-1) ?? "") >= 0
        ) {
          continue;
        }
      }
      retainCandidate(selectedNames, entry.name, maxCandidates);
    }
  } catch (error) {
    addDiagnostic(diagnostics, root, configuredDirectory, error);
    return {
      prompts: [],
      candidates: 0,
      watchDirectories: [],
      watchFiles: [],
    };
  }
  if (candidateLimitExceeded) {
    addDiagnostic(
      diagnostics,
      root,
      configuredDirectory,
      new Error(`prompt candidate limit of ${MAX_PROMPTS} files was reached`),
    );
  }
  const prompts: PortablePrompt[] = [];
  const watchFiles = new Set<string>();
  for (const name of selectedNames) {
    const candidate = join(configuredDirectory, name);
    try {
      const canonicalCandidate = await realpath(candidate);
      if (isPathWithin(root.path, canonicalCandidate)) {
        watchFiles.add(canonicalCandidate);
      }
    } catch {
      const target = await containedProspectivePath(candidate, root.path);
      if (target) watchFiles.add(target);
      // File diagnostics are produced by the bounded read below.
    }
    try {
      const file = await readContainedFile(
        candidate,
        root.path,
        MAX_PROMPT_FILE_BYTES,
      );
      const source = new TextDecoder("utf-8", { fatal: true }).decode(
        file.contents,
      );
      prompts.push(parsePromptFile(source, candidate, root.path, file.path));
    } catch (error) {
      let diagnostic = error;
      if (error instanceof SafeFileError) {
        switch (error.reason) {
          case "outside":
            diagnostic = new Error(
              "prompt file resolves outside the configured root",
            );
            break;
          case "not-file":
            diagnostic = new Error("prompt path is not a file");
            break;
          case "too-large":
            diagnostic = new Error(
              `prompt file exceeds ${MAX_PROMPT_FILE_BYTES} bytes`,
            );
            break;
          case "missing":
            diagnostic = new Error("prompt file does not exist");
            break;
          case "unreadable":
            diagnostic = new Error("prompt file is unreadable");
            break;
        }
      }
      addDiagnostic(diagnostics, root, candidate, diagnostic);
    }
  }
  return {
    prompts,
    candidates: selectedNames.length,
    watchDirectories: [directory],
    watchFiles: [...watchFiles].sort(compareText),
  };
}

function uniqueRootLabels(roots: PromptRoot[]): Map<string, string> {
  const baseLabels = roots.map((root) => {
    const raw = root.label || basename(root.path) || "root";
    const safe = hasUnsafeText(raw)
      ? "root"
      : raw.replaceAll("/", "-").replaceAll("\\", "-") || "root";
    return { root, safe };
  });
  const counts = new Map<string, number>();
  for (const { safe } of baseLabels)
    counts.set(safe, (counts.get(safe) ?? 0) + 1);
  return new Map(
    baseLabels.map(({ root, safe }) => {
      const pathHash = sha256(root.path).slice(0, 8);
      const unique = counts.get(safe) === 1 ? safe : `${safe}-${pathHash}`;
      const label =
        byteLength(unique) <= 64
          ? unique
          : `${truncateUtf8(safe, 55)}-${pathHash}`;
      return [root.path, label];
    }),
  );
}

function groupBy<T>(
  values: T[],
  keyFor: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function namespacedName(label: string, name: string): string {
  const candidate = `${label}/${name}`;
  if (byteLength(candidate) <= MAX_NAME_BYTES) return candidate;
  const suffix = `-${sha256(name).slice(0, 8)}`;
  const available =
    MAX_NAME_BYTES - byteLength(label) - byteLength("/") - byteLength(suffix);
  return `${label}/${truncateUtf8(name, available)}${suffix}`;
}

function exposeNames(
  roots: PromptRoot[],
  prompts: PortablePrompt[],
  diagnostics: Diagnostic[],
): CatalogPrompt[] {
  const byRootAndName = groupBy(
    prompts,
    (prompt) => `${prompt.rootPath}\0${prompt.name}`,
  );
  const usable: PortablePrompt[] = [];
  for (const matches of byRootAndName.values()) {
    if (matches.length === 1) {
      const prompt = matches[0];
      if (prompt) usable.push(prompt);
      continue;
    }
    const first = matches[0];
    const root = roots.find((item) => item.path === first?.rootPath);
    if (first && root) {
      addDiagnostic(
        diagnostics,
        root,
        first.sourcePath,
        new Error(
          `duplicate Copilot prompt name ${JSON.stringify(first.name)}`,
        ),
      );
    }
  }

  const byName = groupBy(usable, (prompt) => prompt.name);
  const labels = uniqueRootLabels(roots);
  const exposed = usable.map((prompt): CatalogPrompt => {
    const crossRootCollision =
      new Set((byName.get(prompt.name) ?? []).map((item) => item.rootPath))
        .size > 1;
    return {
      exposedName: crossRootCollision
        ? namespacedName(labels.get(prompt.rootPath) ?? "root", prompt.name)
        : prompt.name,
      prompt,
    };
  });

  const byExposedName = groupBy(exposed, (entry) => entry.exposedName);
  const result: CatalogPrompt[] = [];
  for (const matches of byExposedName.values()) {
    if (matches.length === 1) {
      const prompt = matches[0];
      if (prompt) result.push(prompt);
      continue;
    }
    for (const match of matches) {
      const root = roots.find((item) => item.path === match.prompt.rootPath);
      if (root) {
        addDiagnostic(
          diagnostics,
          root,
          match.prompt.sourcePath,
          new Error(
            `MCP prompt name collision ${JSON.stringify(match.exposedName)}`,
          ),
        );
      }
    }
  }
  return result.sort((left, right) =>
    compareText(left.exposedName, right.exposedName),
  );
}

export async function discoverPrompts(
  roots: PromptRoot[],
): Promise<DiscoveryResult> {
  const orderedRoots = [...roots].sort((left, right) =>
    compareText(left.path, right.path),
  );
  const diagnostics: Diagnostic[] = [];
  const discovered: PortablePrompt[] = [];
  const watchDirectories = new Set<string>();
  const watchFiles = new Set<string>();
  let remainingCandidates = MAX_PROMPTS;
  for (const root of orderedRoots) {
    if (remainingCandidates === 0) {
      if (diagnostics.length < MAX_DIAGNOSTICS) {
        diagnostics.push({
          path: ".github/prompts",
          message: `prompt candidate limit of ${MAX_PROMPTS} files was reached`,
        });
      }
      break;
    }
    const result = await discoverRoot(root, diagnostics, remainingCandidates);
    discovered.push(...result.prompts);
    for (const path of result.watchDirectories) watchDirectories.add(path);
    for (const path of result.watchFiles) watchFiles.add(path);
    remainingCandidates -= result.candidates;
  }
  const prompts = exposeNames(orderedRoots, discovered, diagnostics);
  diagnostics.sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.message, right.message),
  );
  const signature = sha256(
    JSON.stringify({
      roots: orderedRoots,
      prompts: prompts.map(({ exposedName, prompt }) => ({
        exposedName,
        rootPath: prompt.rootPath,
        sourcePath: prompt.sourcePath,
        sourceRealPath: prompt.sourceRealPath,
        contentHash: prompt.contentHash,
      })),
    }),
  );
  return {
    signature,
    prompts,
    diagnostics,
    watchDirectories: [...watchDirectories].sort(compareText),
    watchFiles: [...watchFiles].sort(compareText),
  };
}
