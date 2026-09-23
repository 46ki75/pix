import type {
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  ScrollView,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { readTail, statusLine } from "./format.ts";
import type { Registry, Task } from "./registry.ts";

export class OutputView {
  private body = new Text("", 0, 0);
  private scroll = new ScrollView(this.body, { follow: "end" });
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(
    private task: () => Task,
    private theme: Pick<Theme, "fg">,
    private height: () => number,
    private renderRequest: () => void,
    private close: () => void,
  ) {
    this.refresh();
    if (this.task().status !== "finished")
      this.timer = setInterval(() => this.refresh(), 1000);
  }

  private refresh(): void {
    if (this.disposed) return;
    this.body.setText(
      readTail(this.task().outputPath)
        .replaceAll("\r", "\n")
        .replaceAll("\t", "  ") || "(no output)",
    );
    if (this.task().status === "finished") clearInterval(this.timer);
    this.invalidate();
    this.renderRequest();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.dispose();
      this.close();
      return;
    }
    if (matchesKey(data, "up")) this.scroll.scrollBy(-1);
    else if (matchesKey(data, "down")) this.scroll.scrollBy(1);
    else if (matchesKey(data, "pageUp"))
      this.scroll.scrollBy(-this.scroll.viewportHeight);
    else if (matchesKey(data, "pageDown"))
      this.scroll.scrollBy(this.scroll.viewportHeight);
    else if (matchesKey(data, "home")) this.scroll.scrollToStart();
    else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
    this.renderRequest();
  }

  render(width: number): string[] {
    const rows = Math.max(1, this.height());
    const content = this.scroll.render(Math.max(1, width));
    // Clip explicitly so this works in both regular and fullscreen Pi layouts.
    this.scroll.updateLayout(
      content.length,
      Math.max(1, rows - 3),
      this.renderRequest,
    );
    return [
      this.theme.fg("accent", truncateToWidth(statusLine(this.task()), width)),
      this.theme.fg(
        "muted",
        truncateToWidth(`Last 8 KiB: ${this.task().outputPath}`, width),
      ),
      ...content.slice(
        this.scroll.scrollTop,
        this.scroll.scrollTop + this.scroll.viewportHeight,
      ),
      this.theme.fg(
        "dim",
        truncateToWidth(
          "↑↓ / PgUp PgDn scroll · End follow · Esc close",
          width,
        ),
      ),
    ]
      .slice(0, rows)
      .map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    this.body.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
  }
}

export class TaskUI {
  private disposed = false;
  private closeViewer: (() => void) | undefined;

  constructor(
    private registry: Registry,
    private ctx: ExtensionContext,
  ) {
    this.update();
  }

  update(): void {
    if (this.disposed) return;
    const running = this.registry
      .list()
      .filter((task) => task.status !== "finished").length;
    this.ctx.ui.setStatus(
      "pix-bg",
      running ? `bg: ${running} running` : undefined,
    );
  }

  async show(ctx: ExtensionCommandContext): Promise<void> {
    while (!this.disposed) {
      const tasks = this.registry.list().reverse();
      if (!tasks.length) {
        ctx.ui.notify("No background tasks.", "info");
        return;
      }
      const labels = tasks.map((task) => statusLine(task));
      const selection = await ctx.ui.select("Background tasks", labels);
      if (this.disposed || !selection) return;
      const selected = tasks[labels.indexOf(selection)];
      if (!selected) return;
      const task = this.registry.get(selected.id);
      const action = await ctx.ui.select(statusLine(task), [
        "View output",
        ...(task.status === "running" ? ["Kill"] : []),
        "Back",
      ]);
      if (this.disposed) return;
      if (action === "View output") {
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          const view = new OutputView(
            () => this.registry.get(task.id),
            theme,
            () => Math.max(4, tui.terminal.rows - 4),
            () => tui.requestRender(),
            () => done(),
          );
          this.closeViewer = () => {
            view.dispose();
            done();
          };
          return view;
        });
        this.closeViewer = undefined;
      } else if (
        action === "Kill" &&
        (await ctx.ui.confirm("Kill background task?", statusLine(task)))
      ) {
        if (this.disposed) return;
        try {
          await this.registry.stop(task.id, "user");
        } catch (error) {
          ctx.ui.notify(String(error), "error");
        }
      } else if (!action) return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closeViewer?.();
    this.ctx.ui.setStatus("pix-bg", undefined);
  }
}
