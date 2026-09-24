import {
  DynamicBorder,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  ScrollView,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { oneLine, readTail, statusLine } from "./format.ts";
import type { Registry, Task } from "./registry.ts";

type StatusTheme = Pick<Theme, "fg" | "getColorMode">;
type StatusColor = "running" | "success" | "error" | "warning" | "muted";

function runningColor(theme: StatusTheme, text: string): string {
  // #68779f; palette 67 is its nearest xterm-256 color (95, 135, 175).
  const blue =
    theme.getColorMode() === "truecolor"
      ? "\x1b[38;2;104;119;159m"
      : "\x1b[38;5;67m";
  return `${blue}${text}\x1b[39m`;
}

function statusColor(task: Task): StatusColor {
  if (task.status !== "finished") return "running";
  switch (task.outcome?.kind) {
    case "exited":
      return task.outcome.code === 0 ? "success" : "error";
    case "signaled":
    case "failed":
      return "error";
    case "timed_out":
    case "output_capped":
      return "warning";
    case "killed":
      return "muted";
    default:
      return "error";
  }
}

const statusIcons: Record<StatusColor, string> = {
  running: "",
  success: "",
  error: "",
  warning: "",
  muted: "",
};

function statusIcon(theme: StatusTheme, color: StatusColor): string {
  const icon = statusIcons[color];
  return color === "running"
    ? runningColor(theme, icon)
    : theme.fg(color, icon);
}

const legend: readonly (readonly [StatusColor, string])[] = [
  ["running", "Running"],
  ["success", "Succeeded"],
  ["error", "Failed"],
  ["warning", "Timeout"],
  ["muted", "Killed"],
];

function renderLegend(
  theme: StatusTheme,
  counts?: Partial<Record<StatusColor, number>>,
): string {
  return legend
    .map(([color, label]) => {
      const text = counts
        ? `${theme.fg("dim", `${label}:`)} ${theme.fg("text", String(counts[color] ?? 0))}`
        : theme.fg("text", label);
      return `${statusIcon(theme, color)} ${text}`;
    })
    .join(" ");
}

export class TaskListView {
  private border: DynamicBorder;
  private list: SelectList;
  private ids: string[] = [];
  private disposed = false;

  constructor(
    private tasks: () => Task[],
    private theme: StatusTheme,
    private height: () => number,
    private renderRequest: () => void,
    private done: (id: string | undefined) => void,
  ) {
    // Extension-loaded DynamicBorder cannot rely on Pi's global theme instance.
    this.border = new DynamicBorder((text) => this.theme.fg("border", text));
    this.list = this.createList(1);
  }

  private createList(maxVisible: number): SelectList {
    const selected = this.list?.getSelectedItem()?.value;
    const tasks = this.tasks().toReversed();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    this.ids = tasks.map((task) => task.id);
    const list = new SelectList(
      tasks.map((task) => ({ value: task.id, label: statusLine(task) })),
      maxVisible,
      {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("muted", text),
      },
      {
        truncatePrimary: ({ item, isSelected, maxWidth }) => {
          const task = byId.get(item.value);
          if (!task) return "";
          const icon = `${statusIcon(this.theme, statusColor(task))} `;
          const now = Date.now();
          // Reserve the ID, outcome, and duration before budgeting a long name.
          const fixedWidth = visibleWidth(
            icon + statusLine({ ...task, name: "" }, now),
          );
          const name = truncateToWidth(
            oneLine(task.name),
            Math.max(0, maxWidth - fixedWidth),
          );
          const text = statusLine({ ...task, name }, now);
          // Pi's fg() does not restore an enclosing color after a nested reset.
          // Style the row text separately so the icon keeps its status color.
          const line =
            icon + this.theme.fg(isSelected ? "accent" : "text", text);
          return truncateToWidth(line, Math.max(0, maxWidth), "");
        },
      },
    );
    list.setSelectedIndex(Math.max(0, this.ids.indexOf(selected ?? "")));
    list.onSelect = (item) => this.finish(item.value);
    list.onCancel = () => this.finish(undefined);
    return list;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (data === "j" || data === "k") {
      const index = this.ids.indexOf(this.list.getSelectedItem()?.value ?? "");
      this.list.setSelectedIndex(index + (data === "j" ? 1 : -1));
    } else this.list.handleInput(data);
    this.renderRequest();
  }

  render(width: number): string[] {
    if (this.disposed || width < 1) return [];
    const height = Math.max(1, this.height());
    // Leave room for the title and a task before spending rows on decoration.
    const border = height >= 4 ? this.border.render(width) : [];
    const rows = height - 2 * border.length;
    // Collapse spacing on short viewports rather than hide the selected task.
    const margin = rows >= 6 ? [""] : [];
    const contentRows = rows - 2 * margin.length;
    const legendText = renderLegend(this.theme);
    // On tiny terminals prioritize at least one task row over the full legend.
    const legendLines = wrapTextWithAnsi(legendText, width).slice(
      0,
      Math.max(0, contentRows - 4),
    );
    const listHeight = Math.max(1, contentRows - legendLines.length - 2);
    // Reserve a line for SelectList's scroll position when the tasks overflow.
    this.list = this.createList(Math.max(1, listHeight - 1));
    const content = [
      this.theme.fg("accent", "Background tasks"),
      ...margin,
      ...this.list.render(width).slice(0, listHeight),
      ...margin,
      ...legendLines,
      this.theme.fg(
        "dim",
        "↑↓ / j k navigate · enter select · esc/ctrl+c cancel",
      ),
    ].slice(0, rows);
    return [...border, ...content, ...border].map((line) =>
      truncateToWidth(line, width),
    );
  }

  invalidate(): void {}

  private finish(id: string | undefined): void {
    if (this.disposed) return;
    this.dispose();
    this.done(id);
  }

  dispose(): void {
    this.disposed = true;
  }
}

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
  private closeView: (() => void) | undefined;
  private renderIndicator: (() => void) | undefined;
  private counts: Partial<Record<StatusColor, number>> = {};

  constructor(
    private registry: Registry,
    private ctx: ExtensionContext,
  ) {
    this.update();
  }

  update(): void {
    if (this.disposed) return;
    const tasks = this.registry.list();
    if (!tasks.length) return;
    this.counts = {};
    for (const task of tasks) {
      const color = statusColor(task);
      this.counts[color] = (this.counts[color] ?? 0) + 1;
    }
    if (this.renderIndicator) {
      this.renderIndicator();
      return;
    }
    // setStatus stores precolored strings. A widget resolves theme tokens on
    // every render, including idle theme changes, without replacing Pi's footer.
    this.ctx.ui.setWidget(
      "pix-bg",
      (tui) => {
        this.renderIndicator = () => tui.requestRender();
        return {
          invalidate() {},
          render: (width: number) => {
            if (this.disposed || width < 1) return [];
            const theme = this.ctx.ui.theme;
            const heading =
              theme.fg("borderMuted", "── ") +
              `${theme.fg("muted", "")} ${theme.fg("dim", "Background Tasks")} `;
            const rule = theme.fg(
              "borderMuted",
              "─".repeat(Math.max(0, width - visibleWidth(heading))),
            );
            return [
              truncateToWidth(heading + rule, width),
              truncateToWidth(` ${renderLegend(theme, this.counts)}`, width),
            ];
          },
        };
      },
      { placement: "aboveEditor" },
    );
  }

  async show(ctx: ExtensionCommandContext): Promise<void> {
    while (!this.disposed) {
      if (!this.registry.list().length) {
        ctx.ui.notify("No background tasks.", "info");
        return;
      }
      const selected = await ctx.ui.custom<string | undefined>(
        (tui, theme, _keys, done) => {
          const view = new TaskListView(
            () => this.registry.list(),
            theme,
            () => Math.max(4, tui.terminal.rows - 4),
            () => tui.requestRender(),
            done,
          );
          this.closeView = () => {
            view.dispose();
            done(undefined);
          };
          // Registry events already request a render through update(); the list
          // reads fresh snapshots during rendering, without a polling timer.
          return view;
        },
      );
      this.closeView = undefined;
      if (this.disposed || !selected) return;
      const task = this.registry.get(selected);
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
          this.closeView = () => {
            view.dispose();
            done();
          };
          return view;
        });
        this.closeView = undefined;
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
    this.closeView?.();
    this.ctx.ui.setWidget("pix-bg", undefined);
    this.renderIndicator = undefined;
  }
}
