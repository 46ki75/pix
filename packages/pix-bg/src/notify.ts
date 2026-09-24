import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completionText } from "./format.ts";
import type { Task } from "./registry.ts";

export class Notifier {
  private pending: Task[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private send: ExtensionAPI["sendMessage"],
    private wake = true,
  ) {}

  completed(task: Task): void {
    if (this.disposed || !task.outcome) return;
    if (task.outcome.kind === "killed") {
      if (task.outcome.by === "user") this.deliver([task], false);
      return;
    }
    this.pending.push(task);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      const tasks = this.pending.splice(0);
      // Bound each model-facing message even when many tasks finish together.
      for (let i = 0; i < tasks.length; i += 8)
        this.deliver(tasks.slice(i, i + 8), this.wake);
    }, 250);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.pending = [];
  }

  private deliver(tasks: Task[], wake: boolean): void {
    this.send(
      {
        customType: "pix-bg-completion",
        content: `Background task completion:\n\n${tasks.map(completionText).join("\n\n")}`,
        display: true,
        details: { tasks },
      },
      { deliverAs: wake ? "followUp" : "nextTurn", triggerTurn: wake },
    );
  }
}
