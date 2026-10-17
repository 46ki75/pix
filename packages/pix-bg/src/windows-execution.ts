import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type {
  Execution,
  ExecutionObserver,
  ExecutionOutcome,
  Executor,
} from "./execution.ts";
import {
  windowsCommandEnvironment,
  windowsHelperEnvironment,
  windowsPowerShell,
  windowsScriptArgs,
} from "./windows.ts";

export interface WindowsExecutorOptions {
  shell: { shell: string; args: string[]; commandTransport?: "argv" | "stdin" };
  startupMs?: number;
}

export class WindowsExecutor implements Executor {
  constructor(private options: WindowsExecutorOptions) {
    if (
      options.shell.commandTransport === "stdin" ||
      /(?:^|[\\/])(?:system32|sysnative)[\\/]bash\.exe$/i.test(
        options.shell.shell,
      )
    ) {
      throw new Error(
        "Windows background tasks require Git for Windows Bash; WSL is not supported",
      );
    }
  }

  start(command: string, cwd: string, observer: ExecutionObserver): Execution {
    return new WindowsExecution(this.options, command, cwd, observer);
  }
}

class WindowsExecution implements Execution {
  readonly pid: number;
  readonly ready: Promise<void>;
  private child: ChildProcess;
  private server: Server;
  private control?: Socket;
  private controlClosed = false;
  private buffer = "";
  private startupError = "";
  private acknowledged = false;
  private launchFailed = false;
  private helperExited = false;
  private helperClosed = false;
  private completed = false;
  private stopping = false;
  private signaling = false;
  private reportingError = false;
  private signalError?: Error;
  private outcome?: ExecutionOutcome;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private startupTimer: ReturnType<typeof setTimeout>;
  private drainTimer?: ReturnType<typeof setTimeout>;

  constructor(
    options: WindowsExecutorOptions,
    command: string,
    cwd: string,
    private observer: ExecutionObserver,
  ) {
    const environment = windowsCommandEnvironment(options.shell.shell);
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const pipe = `pix-bg-${randomBytes(24).toString("hex")}`;
    this.server = createServer((socket) => this.connect(socket));
    this.server.maxConnections = 1;
    this.server.on("error", (error) => this.fail(error));
    // Node's default Windows pipe DACL restricts access to the creating user
    // and administrators. Never enable readableAll/writableAll for this IPC.
    this.server.listen({
      path: `\\\\.\\pipe\\${pipe}`,
      readableAll: false,
      writableAll: false,
    });
    try {
      this.child = spawn(
        windowsPowerShell(),
        windowsScriptArgs("windows-runner.ps1", []),
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: windowsHelperEnvironment(environment),
        },
      );
    } catch (error) {
      this.server.close();
      throw error;
    }
    // The supervisor owns the job handle; killing this PID terminates its job.
    this.pid = this.child.pid ?? 0;
    this.startupTimer = setTimeout(
      () =>
        this.fail(
          new Error("Windows task supervisor did not acknowledge launch"),
        ),
      options.startupMs ?? 30_000,
    );
    for (const source of ["stdout", "stderr"] as const) {
      this.child[source]?.on("data", (chunk: Buffer) => {
        if (source === "stderr" && !this.acknowledged)
          this.startupError = (
            this.startupError + chunk.toString("utf8")
          ).slice(-8192);
        if (!this.completed) observer.onData(source, chunk);
      });
      this.child[source]?.on("error", (error: Error) => this.fail(error));
    }
    this.child.on("error", (error) => {
      if (this.signaling) this.signalError = error;
      else this.fail(error);
    });
    this.child.once("exit", () => {
      this.helperExited = true;
      // As on POSIX, escaped processes must not keep output handles open forever.
      this.drainTimer = setTimeout(() => {
        this.child.stdout?.destroy();
        this.child.stderr?.destroy();
        this.control?.destroy();
      }, 100);
    });
    this.child.once("close", () => {
      this.helperExited = true;
      this.helperClosed = true;
      // IOCP can deliver process/stdio closure before an already-connected
      // control pipe's accept callback. Keep listening for its buffered result.
      if (this.launchFailed && !this.control) {
        this.closeServer();
        this.controlClosed = true;
      }
      this.finish();
    });
    // No command text travels through PowerShell's parser or command-line argv.
    this.child.stdin?.on("error", () => {});
    this.child.stdin?.end(
      JSON.stringify({
        shell: options.shell.shell,
        args: [...options.shell.args, command],
        cwd,
        pipe,
        environment: Object.entries(environment)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${value}`),
      }),
      "utf8",
    );
  }

  stop(): void {
    if (this.completed || this.helperExited) return;
    this.stopping = true;
    // Startup must either acknowledge a job-contained command or fail. Queuing
    // an early stop also preserves the registry's shutdown-during-launch ordering.
    if ((this.acknowledged || this.launchFailed) && !this.reportingError)
      this.kill();
  }

  private kill(): void {
    if (this.helperExited || this.child.killed || !this.pid) return;
    this.signaling = true;
    delete this.signalError;
    try {
      this.child.kill("SIGKILL");
    } finally {
      this.signaling = false;
    }
    if (this.signalError) throw this.signalError;
  }

  private stopFromEvent(): void {
    try {
      this.kill();
    } catch (error) {
      this.reportOutputError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private reportOutputError(error: Error): void {
    // Registry error observers request stop themselves. This asynchronous
    // attempt owns signaling; a later explicit stop must still be retryable.
    this.reportingError = true;
    try {
      this.observer.onOutputError(error);
    } finally {
      this.reportingError = false;
    }
  }

  private connect(socket: Socket): void {
    if (this.control || this.launchFailed || this.completed) {
      socket.destroy();
      return;
    }
    this.control = socket;
    this.closeServer();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 65_536) {
        this.fail(new Error("Invalid Windows supervisor control frame"));
        socket.destroy();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end).replace(/\r$/, "");
        this.buffer = this.buffer.slice(end + 1);
        this.frame(line);
      }
    });
    socket.on("error", (error) => this.fail(error));
    socket.once("close", () => {
      this.controlClosed = true;
      if (!this.outcome && !this.launchFailed && !this.stopping)
        this.fail(
          new Error("Windows task supervisor closed without a command result"),
        );
      this.finish();
    });
  }

  private frame(line: string): void {
    if (this.completed || this.launchFailed) return;
    if (line === "ready" && !this.acknowledged) {
      this.acknowledged = true;
      clearTimeout(this.startupTimer);
      this.resolveReady();
      if (this.stopping) this.stopFromEvent();
    } else if (/^exit:\d+$/.test(line) && this.acknowledged && !this.outcome) {
      const code = Number(line.slice(5));
      if (!Number.isSafeInteger(code) || code > 0xffff_ffff) {
        this.fail(new Error("Invalid Windows command exit code"));
        return;
      }
      this.outcome = { kind: "exited", code };
      this.observer.onExit(this.outcome);
    } else if (line.startsWith("error:")) {
      this.fail(
        new Error(Buffer.from(line.slice(6), "base64").toString("utf8")),
      );
    } else {
      this.fail(new Error("Invalid Windows supervisor control frame"));
    }
  }

  private fail(error: Error): void {
    if (this.completed || this.launchFailed) return;
    if (!this.acknowledged) {
      this.launchFailed = true;
      clearTimeout(this.startupTimer);
      this.observer.onSpawnError(error);
      this.rejectReady(error);
    } else {
      this.reportOutputError(error);
    }
    this.closeServer();
    if (!this.control && this.helperClosed) this.controlClosed = true;
    this.stopFromEvent();
    this.finish();
  }

  private closeServer(): void {
    if (this.server.listening) this.server.close();
  }

  private finish(): void {
    if (!this.helperClosed || !this.controlClosed || this.completed) return;
    if (!this.acknowledged && !this.launchFailed) {
      this.fail(
        new Error(
          `Windows task supervisor exited before acknowledging launch${this.startupError ? `: ${this.startupError.trim()}` : ""}`,
        ),
      );
      return;
    }
    if (this.acknowledged && !this.outcome) {
      this.outcome = {
        kind: "failed",
        message: "Windows task supervisor was terminated",
      };
      this.observer.onExit(this.outcome);
    }
    clearTimeout(this.startupTimer);
    clearTimeout(this.drainTimer);
    this.completed = true;
    this.observer.onComplete();
  }
}
