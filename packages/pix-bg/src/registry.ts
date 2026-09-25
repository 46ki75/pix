import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { privateDirectory } from "./directory.ts";

export type KillReason = "agent" | "user" | "shutdown";
export type Outcome =
  | { kind: "exited"; code: number }
  | { kind: "signaled"; signal: NodeJS.Signals; code: number }
  | { kind: "timed_out" }
  | { kind: "output_capped" }
  | { kind: "killed"; by: KillReason }
  | { kind: "failed"; message: string };

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
}

interface Entry {
  task: Task;
  child: ChildProcess;
  fd: number;
  done: Promise<Task>;
  resolve: (task: Task) => void;
  exit?: Outcome;
  reason?: Outcome;
  closed: boolean;
  groupClean: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  drainTimer?: ReturnType<typeof setTimeout>;
  timeout?: ReturnType<typeof setTimeout>;
}

export interface RegistryOptions {
  shell: { shell: string; args: string[] };
  outputDir: string;
  maxOutputBytes: number;
  graceMs?: number;
  now?: () => number;
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
  private listeners = new Set<(task: Task) => void>();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private now: () => number;

  constructor(private options: RegistryOptions) {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("pix-bg supports macOS and Linux only");
    }
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
    let child: ChildProcess;
    try {
      child = spawn(
        this.options.shell.shell,
        [...this.options.shell.args, params.command],
        {
          cwd: params.cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    let resolve!: (task: Task) => void;
    const done = new Promise<Task>((resolveTask) => {
      resolve = resolveTask;
    });
    const entry: Entry = {
      task: {
        id,
        name:
          params.name?.trim() ||
          params.command.replace(/\s+/g, " ").slice(0, 80),
        command: params.command,
        cwd: params.cwd,
        pid: child.pid ?? 0,
        outputPath,
        outputBytes: 0,
        startedAt: this.now(),
        status: "running",
      },
      child,
      fd,
      done,
      resolve,
      closed: false,
      groupClean: false,
    };
    this.entries.set(id, entry);
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new OutputDecoder();
      stream?.on("data", (chunk: Buffer) =>
        this.output(entry, decoder.decode(chunk)),
      );
      stream?.on("error", (error: Error) =>
        this.terminate(entry, { kind: "failed", message: error.message }),
      );
    }
    child.once("exit", (code, signal) => {
      entry.exit = signal
        ? { kind: "signaled", signal, code: 128 + constants.signals[signal] }
        : code !== null
          ? { kind: "exited", code }
          : {
              kind: "failed",
              message: "Command terminated without an exit code",
            };
      clearTimeout(entry.timeout);
      // The shell owns task lifetime; leftover group members are not independent tasks.
      this.cleanGroup(entry);
    });
    child.once("close", () => {
      entry.closed = true;
      this.finish(entry);
    });
    const spawned = new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", (error) => {
        entry.exit = { kind: "failed", message: error.message };
        entry.reason = entry.exit;
        entry.groupClean = true;
        clearTimeout(entry.timeout);
        this.entries.delete(id);
        rejectSpawn(error);
      });
    });
    if (params.timeout !== undefined) {
      entry.timeout = setTimeout(
        () => this.terminate(entry, { kind: "timed_out" }),
        params.timeout * 1000,
      );
    }
    await spawned;
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
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.listeners.clear();
    this.disposal = Promise.all(
      [...this.entries.values()].map((entry) => {
        if (entry.task.status !== "finished" && !entry.exit)
          this.terminate(entry, { kind: "killed", by: "shutdown" });
        return entry.done;
      }),
    ).then(() => undefined);
    return this.disposal;
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
      this.terminate(entry, { kind: "failed", message: String(error) });
      return;
    }
    if (data.length > remaining)
      this.terminate(entry, { kind: "output_capped" });
  }

  private signal(entry: Entry, signal: NodeJS.Signals | 0): boolean {
    if (!entry.task.pid) return false;
    try {
      process.kill(-entry.task.pid, signal);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      // A denied existence probe does not prove the group is gone. Actual
      // signal-delivery errors must still surface rather than claim cleanup.
      if (signal === 0 && code === "EPERM") return true;
      throw error;
    }
  }

  private terminate(entry: Entry, reason: Outcome): void {
    if (entry.task.status === "finished") return;
    // First cause wins even if another stop request arrives during escalation.
    entry.reason ??= reason;
    entry.task.status = "stopping";
    clearTimeout(entry.timeout);
    this.cleanGroup(entry);
    this.emit(entry);
  }

  private cleanGroup(entry: Entry): void {
    if (!entry.groupClean) {
      if (entry.cleanupTimer) {
        // Repeated signals can hit zombie-only groups (EPERM on macOS, #37).
        // Share pending cleanup; only probe after exit to avoid delaying a
        // group already gone, without abandoning escalation for descendants.
        if (!entry.exit || this.signal(entry, 0)) return;
        clearTimeout(entry.cleanupTimer);
        entry.groupClean = true;
      } else if (!this.signal(entry, "SIGTERM")) {
        entry.groupClean = true;
      } else {
        entry.cleanupTimer = setTimeout(() => {
          this.signal(entry, "SIGKILL");
          entry.groupClean = true;
          this.drain(entry);
          this.finish(entry);
        }, this.options.graceMs ?? 2000);
      }
    }
    // SIGKILL can precede the shell's exit event; drain once exit is known.
    if (entry.groupClean) this.drain(entry);
    this.finish(entry);
  }

  private drain(entry: Entry): void {
    if (!entry.exit || entry.closed || entry.drainTimer) return;
    // Escaped descendants may retain pipe handles. Never wait on them forever.
    entry.drainTimer = setTimeout(() => {
      entry.child.stdout?.destroy();
      entry.child.stderr?.destroy();
    }, 100);
  }

  private finish(entry: Entry): void {
    if (
      !entry.exit ||
      !entry.closed ||
      !entry.groupClean ||
      entry.task.status === "finished"
    )
      return;
    clearTimeout(entry.timeout);
    clearTimeout(entry.cleanupTimer);
    clearTimeout(entry.drainTimer);
    closeSync(entry.fd);
    entry.task.status = "finished";
    entry.task.outcome = entry.reason ?? entry.exit;
    entry.task.endedAt = this.now();
    entry.resolve(snapshot(entry.task));
    if (this.entries.has(entry.task.id)) this.emit(entry);
  }
}
