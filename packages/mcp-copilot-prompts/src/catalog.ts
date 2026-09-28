import { dirname, join, resolve } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { discoverPrompts } from "./discovery.js";
import type {
  CatalogPrompt,
  CatalogSnapshot,
  Diagnostic,
  PromptRoot,
} from "./types.js";
import { isPathWithin } from "./util.js";

export interface CatalogOptions {
  reportDiagnostic?: (diagnostic: Diagnostic) => void;
  onChanged?: () => void | Promise<void>;
  watch?: boolean;
}

function sameRoots(left: PromptRoot[], right: PromptRoot[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (root, index) =>
        root.path === right[index]?.path && root.label === right[index]?.label,
    )
  );
}

export class PromptCatalog {
  private roots: PromptRoot[] = [];
  private readonly reportDiagnostic:
    | ((diagnostic: Diagnostic) => void)
    | undefined;
  private readonly onChanged: (() => void | Promise<void>) | undefined;
  private readonly shouldWatch: boolean;
  private watcher: FSWatcher | undefined;
  private finishWatcherReady: (() => void) | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private refreshChain: Promise<boolean> = Promise.resolve(false);
  private pendingRefresh:
    | { promise: Promise<boolean>; rootVersion: number }
    | undefined;
  private refreshRequested = false;
  private rootVersion = 0;
  private diagnosticSignature = "";
  private watcherTopologySignature = "";
  private watchDirectories: string[] = [];
  private watchFiles: string[] = [];
  private closed = false;
  private state: CatalogSnapshot = {
    generation: 0,
    signature: "",
    prompts: [],
    diagnostics: [],
  };

  constructor(options: CatalogOptions = {}) {
    this.reportDiagnostic = options.reportDiagnostic;
    this.onChanged = options.onChanged;
    this.shouldWatch = options.watch !== false;
  }

  snapshot(): CatalogSnapshot {
    return this.state;
  }

  find(name: string): CatalogPrompt | undefined {
    return this.state.prompts.find((entry) => entry.exposedName === name);
  }

  async setRoots(roots: PromptRoot[]): Promise<boolean> {
    if (this.closed) throw new Error("prompt catalog is closed");
    this.rootVersion++;
    const operation = this.refreshChain.then(
      () => this.setRootsNow(roots),
      () => this.setRootsNow(roots),
    );
    this.refreshChain = operation.catch(() => false);
    return operation;
  }

  private async setRootsNow(roots: PromptRoot[]): Promise<boolean> {
    if (this.closed) return false;
    if (!sameRoots(this.roots, roots)) this.roots = [...roots];
    return this.refreshNow();
  }

  refresh(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.pendingRefresh?.rootVersion === this.rootVersion) {
      this.refreshRequested = true;
      return this.pendingRefresh.promise;
    }
    const rootVersion = this.rootVersion;
    const refreshUntilClean = async (): Promise<boolean> => {
      let changed = false;
      do {
        this.refreshRequested = false;
        changed = (await this.refreshNow()) || changed;
      } while (
        this.refreshRequested &&
        this.rootVersion === rootVersion &&
        !this.closed
      );
      return changed;
    };
    const operation = this.refreshChain.then(
      refreshUntilClean,
      refreshUntilClean,
    );
    const pending = { promise: operation, rootVersion };
    this.pendingRefresh = pending;
    operation.then(
      () => {
        if (this.pendingRefresh === pending) this.pendingRefresh = undefined;
      },
      () => {
        if (this.pendingRefresh === pending) this.pendingRefresh = undefined;
      },
    );
    this.refreshChain = operation.catch(() => false);
    return operation;
  }

  private async refreshNow(): Promise<boolean> {
    const result = await discoverPrompts(this.roots);
    const diagnostics = JSON.stringify(result.diagnostics);
    if (diagnostics !== this.diagnosticSignature) {
      this.diagnosticSignature = diagnostics;
      for (const diagnostic of result.diagnostics) {
        this.reportDiagnostic?.(diagnostic);
      }
    }
    const watcherTopologySignature = JSON.stringify([
      this.roots,
      result.watchDirectories,
      result.watchFiles,
    ]);
    const watcherTopologyChanged =
      watcherTopologySignature !== this.watcherTopologySignature;
    this.watcherTopologySignature = watcherTopologySignature;
    this.watchDirectories = result.watchDirectories;
    this.watchFiles = result.watchFiles;
    if (result.signature === this.state.signature) {
      this.state = { ...this.state, diagnostics: result.diagnostics };
      if (watcherTopologyChanged) await this.replaceWatcher();
      return false;
    }
    this.state = {
      generation: this.state.generation + 1,
      signature: result.signature,
      prompts: result.prompts,
      diagnostics: result.diagnostics,
    };
    if (watcherTopologyChanged) await this.replaceWatcher();
    await this.onChanged?.();
    return true;
  }

  private async replaceWatcher(): Promise<void> {
    this.finishWatcherReady?.();
    this.finishWatcherReady = undefined;
    await this.watcher?.close();
    this.watcher = undefined;
    if (this.closed || !this.shouldWatch || this.roots.length === 0) return;

    const allowedDirectories = new Set<string>();
    const promptDirectories = new Set<string>();
    const promptFiles = new Set<string>();
    const watchTargets = new Set(this.roots.map((root) => root.path));
    const allowTargetAncestors = (target: string): boolean => {
      const root = this.roots.find((item) => isPathWithin(item.path, target));
      if (!root) return false;
      let current = dirname(target);
      while (isPathWithin(root.path, current)) {
        allowedDirectories.add(current);
        if (current === root.path) break;
        current = dirname(current);
      }
      return true;
    };
    for (const root of this.roots) {
      const github = join(root.path, ".github");
      const prompts = join(github, "prompts");
      allowedDirectories.add(root.path);
      allowedDirectories.add(github);
      allowedDirectories.add(prompts);
      promptDirectories.add(prompts);
    }
    for (const directory of this.watchDirectories) {
      if (!allowTargetAncestors(directory)) continue;
      allowedDirectories.add(directory);
      promptDirectories.add(directory);
      watchTargets.add(directory);
    }
    for (const file of this.watchFiles) {
      if (!allowTargetAncestors(file)) continue;
      promptFiles.add(file);
      watchTargets.add(file);
    }
    if (this.closed) return;
    const watcher = watch([...watchTargets], {
      atomic: true,
      awaitWriteFinish: { pollInterval: 50, stabilityThreshold: 100 },
      depth: 3,
      followSymlinks: false,
      ignored: (path) => {
        const candidate = resolve(path);
        return (
          !allowedDirectories.has(candidate) &&
          !promptDirectories.has(dirname(candidate)) &&
          !promptFiles.has(candidate)
        );
      },
      ignoreInitial: true,
    });
    watcher.on("all", () => this.scheduleRefresh());
    watcher.on("error", (error: unknown) => {
      this.reportDiagnostic?.({
        path: ".github/prompts",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.watcher = watcher;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        watcher.off("ready", done);
        watcher.off("error", doneError);
        if (this.finishWatcherReady === done) {
          this.finishWatcherReady = undefined;
        }
        resolve();
      };
      const doneError = (_error: unknown): void => done();
      this.finishWatcherReady = done;
      watcher.once("ready", done);
      watcher.once("error", doneError);
    });
    if (!this.closed) this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.closed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.refresh().catch((error: unknown) => {
        this.reportDiagnostic?.({
          path: ".github/prompts",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, 75);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.finishWatcherReady?.();
    this.finishWatcherReady = undefined;
    await this.watcher?.close();
    this.watcher = undefined;
    await this.refreshChain;
  }
}
