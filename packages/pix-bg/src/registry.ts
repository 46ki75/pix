import { randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { privateDirectory } from "./directory.ts";
import type { Execution, ExecutionOutcome, Executor } from "./execution.ts";

export type KillReason = "agent" | "user" | "shutdown";
export type Outcome =
  | ExecutionOutcome
  | { kind: "timed_out" }
  | { kind: "output_capped" }
  | { kind: "killed"; by: KillReason };

export interface Task {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid: number;
  outputPath: string;
  outputBytes: number;
  startedAt: number;
  endedAt?: number;
  status: "running" | "stopping" | "finished";
  outcome?: Outcome;
  // Historical diagnostics do not replace the first stop reason or imply completion.
  lastError?: string;
}

interface Entry {
  task: Task;
  execution: Execution;
  fd: number;
  done: Promise<Task>;
  resolve: (task: Task) => void;
  exit?: ExecutionOutcome;
  reason?: Outcome;
  timeout?: ReturnType<typeof setTimeout>;
}

export interface RegistryOptions {
  executor: Executor;
  outputDir: string;
  maxOutputBytes: number;
  now?: () => number;
  onError?: (error: Error, task: Task) => void;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

export function outputLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.PIX_BG_MAX_OUTPUT_BYTES?.trim();
  const value = raw ? Number(raw) : DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("PIX_BG_MAX_OUTPUT_BYTES must be a positive safe integer");
  }
  return value;
}

// Keep escape parsing across pipe chunks without buffering unbounded OSC payloads.
class OutputDecoder {
  private decoder = new StringDecoder("utf8");
  private state: "text" | "escape" | "csi" | "string" | "stringEscape" = "text";

  decode(chunk: Buffer): string {
    let result = "";
    for (const char of this.decoder.write(chunk)) {
      if (this.state === "stringEscape") {
        this.state = char === "\\" ? "text" : "string";
      } else if (this.state === "string") {
        if (char === "\x07" || char === "\x9c") this.state = "text";
        else if (char === "\x1b") this.state = "stringEscape";
      } else if (this.state === "csi") {
        if (char >= "@" && char <= "~") this.state = "text";
      } else if (this.state === "escape") {
        if (char === "[") this.state = "csi";
        else if ("]PX^_".includes(char)) this.state = "string";
        else if (char >= "0" && char <= "~") this.state = "text";
      } else if (char === "\x1b") this.state = "escape";
      else if (char === "\x9b") this.state = "csi";
      else if ("\x90\x9d\x9e\x9f".includes(char)) this.state = "string";
      else result += char;
    }
    return stripVTControlCharacters(result).replace(
      /[\p{Cc}\p{Cs}]/gu,
      (char) => ("\n\r\t".includes(char) ? char : ""),
    );
  }
}

function snapshot(task: Task): Task {
  return { ...task, ...(task.outcome ? { outcome: { ...task.outcome } } : {}) };
}

export class Registry {
  private entries = new Map<string, Entry>();
  // Failed launches disappear publicly before their supervisor/output closes.
  // Keep cleanup ownership independent of visible task retention.
  private pending = new Set<Entry>();
  private listeners = new Set<(task: Task) => void>();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private now: () => number;

  constructor(private options: RegistryOptions) {
    if (
      !Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes <= 0
    ) {
      throw new Error("Output cap must be a positive safe integer");
    }
    this.now = options.now ?? Date.now;
  }

  subscribe(listener: (task: Task) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): Task[] {
    return [...this.entries.values()].map(({ task }) => snapshot(task));
  }

  get(id: string): Task {
    return snapshot(this.entry(id).task);
  }

  wait(id: string): Promise<Task> {
    return this.entry(id).done;
  }

  async start(params: {
    command: string;
    cwd: string;
    name?: string;
    timeout?: number;
  }): Promise<Task> {
    if (this.disposed) throw new Error("Background task registry is shut down");
    if (!params.command.trim()) throw new Error("Command must not be empty");
    if (
      params.timeout !== undefined &&
      (!Number.isFinite(params.timeout) ||
        params.timeout <= 0 ||
        params.timeout * 1000 > 2_147_483_647)
    ) {
      throw new Error(
        "Timeout must be positive and at most 2147483.647 seconds",
      );
    }
    privateDirectory(this.options.outputDir);
    const id = randomBytes(6).toString("hex");
    const outputPath = join(this.options.outputDir, `${id}.log`);
    const fd = openSync(outputPath, "wx", 0o600);
    const decoders = {
      stdout: new OutputDecoder(),
      stderr: new OutputDecoder(),
    };
    let entry!: Entry;
    let execution: Execution;
    try {
      execution = this.options.executor.start(params.command, params.cwd, {
        onData: (source, chunk) =>
          this.output(entry, decoders[source].decode(chunk)),
        onOutputError: (error) => {
          this.reportError(entry, error);
          this.terminate(
            entry,
            { kind: "failed", message: error.message },
            "event",
          );
        },
        onExit: (outcome) => {
          entry.exit = outcome;
          clearTimeout(entry.timeout);
        },
        onSpawnError: (error) => {
          entry.exit = { kind: "failed", message: error.message };
          entry.reason = entry.exit;
          clearTimeout(entry.timeout);
          this.entries.delete(id);
        },
        onComplete: () => this.finish(entry),
      });
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    let resolve!: (task: Task) => void;
    const done = new Promise<Task>((resolveTask) => {
      resolve = resolveTask;
    });
    entry = {
      task: {
        id,
        name:
          params.name?.trim() ||
          params.command.replace(/\s+/g, " ").slice(0, 80),
        command: params.command,
        cwd: params.cwd,
        pid: execution.pid,
        outputPath,
        outputBytes: 0,
        startedAt: this.now(),
        status: "running",
      },
      execution,
      fd,
      done,
      resolve,
    };
    this.entries.set(id, entry);
    this.pending.add(entry);
    if (params.timeout !== undefined) {
      entry.timeout = setTimeout(
        () => this.terminate(entry, { kind: "timed_out" }, "event"),
        params.timeout * 1000,
      );
    }
    await execution.ready;
    this.emit(entry);
    return snapshot(entry.task);
  }

  async stop(id: string, by: KillReason): Promise<Task> {
    const entry = this.entry(id);
    if (entry.task.status === "finished" || entry.exit)
      throw new Error(`Task ${id} has already exited`);
    this.terminate(entry, { kind: "killed", by });
    return entry.done;
  }

  disposeAll(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
    const entries = [...this.pending];
    // An asynchronous delivery failure can make an earlier stop retryable even
    // while callers are already joining the same pending disposal promise.
    for (const entry of entries) {
      if (!entry.exit || !this.entries.has(entry.task.id))
        this.terminate(entry, { kind: "killed", by: "shutdown" });
    }
    return (this.disposal ??= Promise.all(
      entries.map((entry) => entry.done),
    ).then(() => undefined));
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown background task: ${id}`);
    return entry;
  }

  private emit(entry: Entry): void {
    for (const listener of this.listeners) listener(snapshot(entry.task));
  }

  private output(entry: Entry, text: string): void {
    if (
      entry.task.status === "finished" ||
      entry.reason?.kind === "output_capped"
    )
      return;
    // The cap bounds stored logs, not raw bytes: stripped controls do not count.
    const data = Buffer.from(text);
    const remaining = this.options.maxOutputBytes - entry.task.outputBytes;
    try {
      // Synchronous, bounded pipe-chunk writes avoid an unbounded write queue.
      const portion = data.subarray(0, remaining);
      let offset = 0;
      while (offset < portion.length)
        offset += writeSync(entry.fd, portion, offset);
      entry.task.outputBytes += portion.length;
    } catch (error) {
      this.reportError(entry, error);
      this.terminate(
        entry,
        { kind: "failed", message: String(error) },
        "event",
      );
      return;
    }
    if (data.length > remaining)
      this.terminate(entry, { kind: "output_capped" }, "event");
  }

  private reportError(entry: Entry, error: unknown): void {
    if (entry.task.status === "finished") return;
    const failure = error instanceof Error ? error : new Error(String(error));
    entry.task.lastError = failure.message;
    this.options.onError?.(failure, snapshot(entry.task));
  }

  private terminate(
    entry: Entry,
    reason: Outcome,
    mode: "explicit" | "event" = "explicit",
  ): void {
    if (entry.task.status === "finished") return;
    // First cause wins even if another stop request arrives during escalation.
    entry.reason ??= reason;
    entry.task.status = "stopping";
    clearTimeout(entry.timeout);
    try {
      entry.execution.stop();
    } catch (error) {
      // Timer/IO callbacks cannot return delivery errors to a caller. Report
      // them without abandoning cleanup; explicit stop/shutdown still throw.
      if (mode === "explicit") throw error;
      this.reportError(entry, error);
    }
    this.emit(entry);
  }

  private finish(entry: Entry): void {
    if (!entry.exit || entry.task.status === "finished") return;
    clearTimeout(entry.timeout);
    closeSync(entry.fd);
    entry.task.status = "finished";
    entry.task.outcome = entry.reason ?? entry.exit;
    entry.task.endedAt = this.now();
    this.pending.delete(entry);
    entry.resolve(snapshot(entry.task));
    if (this.entries.has(entry.task.id)) this.emit(entry);
  }
}
