import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import type { Execution, ExecutionObserver, Executor } from "./execution.ts";

export interface PosixExecutorOptions {
  shell: { shell: string; args: string[] };
  graceMs?: number;
}

export class PosixExecutor implements Executor {
  constructor(private options: PosixExecutorOptions) {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("pix-bg supports macOS and Linux only");
    }
  }

  start(command: string, cwd: string, observer: ExecutionObserver): Execution {
    return new PosixExecution(this.options, command, cwd, observer);
  }
}

class PosixExecution implements Execution {
  readonly pid: number;
  readonly ready: Promise<void>;
  private child: ChildProcess;
  private exited = false;
  private closed = false;
  private groupClean = false;
  private completed = false;
  private cleanupTimer?: ReturnType<typeof setTimeout>;
  private drainTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private options: PosixExecutorOptions,
    command: string,
    cwd: string,
    private observer: ExecutionObserver,
  ) {
    this.child = spawn(options.shell.shell, [...options.shell.args, command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.pid = this.child.pid ?? 0;
    for (const source of ["stdout", "stderr"] as const) {
      this.child[source]?.on("data", (chunk: Buffer) =>
        observer.onData(source, chunk),
      );
      this.child[source]?.on("error", (error: Error) =>
        observer.onOutputError(error),
      );
    }
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      observer.onExit(
        signal
          ? { kind: "signaled", signal, code: 128 + constants.signals[signal] }
          : code !== null
            ? { kind: "exited", code }
            : {
                kind: "failed",
                message: "Command terminated without an exit code",
              },
      );
      // The shell owns task lifetime; leftover group members are not independent tasks.
      this.cleanGroup();
    });
    this.child.once("close", () => {
      this.closed = true;
      this.finish();
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", (error) => {
        this.exited = true;
        this.groupClean = true;
        observer.onSpawnError(error);
        reject(error);
      });
    });
  }

  stop(): void {
    if (!this.completed) this.cleanGroup();
  }

  private signal(signal: NodeJS.Signals | 0): boolean {
    if (!this.pid) return false;
    try {
      process.kill(-this.pid, signal);
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

  private cleanGroup(): void {
    if (!this.groupClean) {
      if (this.cleanupTimer) {
        // Repeated signals can hit zombie-only groups (EPERM on macOS, #37).
        // Share pending cleanup; only probe after exit to avoid delaying a
        // group already gone, without abandoning escalation for descendants.
        if (!this.exited || this.signal(0)) return;
        clearTimeout(this.cleanupTimer);
        this.groupClean = true;
      } else if (!this.signal("SIGTERM")) {
        this.groupClean = true;
      } else {
        this.cleanupTimer = setTimeout(() => {
          // An expired timer is not pending cleanup; a failed signal must
          // leave later stop/disposal/exit requests able to retry.
          delete this.cleanupTimer;
          this.signal("SIGKILL");
          this.groupClean = true;
          this.drain();
          this.finish();
        }, this.options.graceMs ?? 2000);
      }
    }
    // SIGKILL can precede the shell's exit event; drain once exit is known.
    if (this.groupClean) this.drain();
    this.finish();
  }

  private drain(): void {
    if (!this.exited || this.closed || this.drainTimer) return;
    // Escaped descendants may retain pipe handles. Never wait on them forever.
    this.drainTimer = setTimeout(() => {
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
    }, 100);
  }

  private finish(): void {
    if (!this.exited || !this.closed || !this.groupClean || this.completed)
      return;
    clearTimeout(this.cleanupTimer);
    clearTimeout(this.drainTimer);
    this.completed = true;
    this.observer.onComplete();
  }
}
