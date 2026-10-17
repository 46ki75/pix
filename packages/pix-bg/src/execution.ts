export type ExecutionOutcome =
  | { kind: "exited"; code: number }
  | { kind: "signaled"; signal: NodeJS.Signals; code: number }
  | { kind: "failed"; message: string };

export type OutputSource = "stdout" | "stderr";

export interface ExecutionObserver {
  // Sources must stay distinct so the registry can decode split UTF-8/ANSI data.
  onData(source: OutputSource, chunk: Buffer): void;
  onOutputError(error: Error): void;
  // Shell exit ends the command, but output and descendant cleanup may remain.
  onExit(outcome: ExecutionOutcome): void;
  onSpawnError(error: Error): void;
  // Exactly once, after exit (or spawn failure), output closure, and cleanup.
  // No output may follow this callback.
  onComplete(): void;
}

export interface Execution {
  readonly pid: number;
  // Resolves only after the OS acknowledges launch; rejects on spawn failure.
  readonly ready: Promise<void>;
  // Initiates cleanup, not completion. Concurrent calls share pending cleanup.
  // Synchronous delivery errors must surface and leave cleanup retryable.
  stop(): void;
}

export interface Executor {
  // Returns a handle synchronously so shutdown can stop a still-launching task.
  // Observers must not be called before start returns. Synchronous failures
  // must not leave a live process behind.
  start(command: string, cwd: string, observer: ExecutionObserver): Execution;
}
