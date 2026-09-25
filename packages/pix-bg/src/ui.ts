import {
  DynamicBorder,
  type ExtensionCommandContext,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Keybinding,
  ScrollView,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  duration,
  oneLine,
  outcomeText,
  readTail,
  statusLine,
} from "./format.ts";
import type { Registry, Task } from "./registry.ts";

type StatusTheme = Pick<Theme, "fg" | "getColorMode">;
type StatusColor = "running" | "success" | "error" | "warning" | "muted";
type UIKeys = Pick<KeybindingsManager, "matches" | "getKeys">;

// Pi's fullscreen dock needs two indicator rows, its leading spacer, two
// default footer rows, and at least one transcript row outside the custom view.
const surroundingRows = 6;

function viewHeight(terminalRows: number, minimum = 1): number {
  return Math.max(minimum, terminalRows - surroundingRows);
}

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

type TaskColumns = {
  prefix: number;
  nameEnd: number;
  result: number;
  time: number;
};

function taskResult(task: Task): string {
  const outcome = task.outcome;
  return outcome?.kind === "exited"
    ? `󰐦 ${outcome.code}`
    : outcome?.kind === "signaled"
      ? `󰐦 ${outcome.code} (${outcome.signal})`
      : outcome
        ? outcomeText(outcome)
        : task.status;
}

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function renderTaskLine(
  theme: StatusTheme,
  task: Task,
  width: number,
  color: "accent" | "text",
  now = Date.now(),
  columns?: TaskColumns,
): string {
  const icon = `${statusIcon(theme, statusColor(task))} `;
  const prefix = `${task.id}  `;
  const tailWidth = columns ? columns.result + columns.time + 2 : 0;
  // Drop padding before truncating details when the shared fixed columns cannot fit.
  const aligned =
    columns && width >= columns.prefix + tailWidth ? columns : undefined;
  const result = padToWidth(taskResult(task), aligned?.result ?? 0);
  const suffix = ` ${result} 󰔛 ${duration(task, now)}`;
  // Reserve the ID, outcome, and duration before budgeting a long name in either view.
  const nameWidth = aligned
    ? Math.min(aligned.nameEnd, width - tailWidth) - visibleWidth(icon + prefix)
    : Math.max(0, width - visibleWidth(icon + prefix + suffix));
  const truncated = truncateToWidth(oneLine(task.name), nameWidth);
  const name = aligned ? padToWidth(truncated, nameWidth) : truncated;
  // Pi's fg() does not restore an enclosing color after a nested reset.
  // Style the text separately so the icon keeps its status color.
  return truncateToWidth(
    icon + theme.fg(color, prefix + name + suffix),
    Math.max(0, width),
    "",
  );
}

const statusLabels: readonly (readonly [StatusColor, string])[] = [
  ["running", "Running"],
  ["success", "Succeeded"],
  ["error", "Failed"],
  ["warning", "Timeout"],
  ["muted", "Killed"],
];

function renderCounts(
  theme: StatusTheme,
  counts: Partial<Record<StatusColor, number>>,
): string {
  return statusLabels
    .map(([color, label]) => {
      const text = `${theme.fg("dim", label)} ${theme.fg("text", String(counts[color] ?? 0))}`;
      return `${statusIcon(theme, color)} ${text}`;
    })
    .join(" ");
}

function renderHint(
  theme: Pick<Theme, "fg">,
  keys: UIKeys,
  actions: [Keybinding[], string][],
): string {
  const hints = actions.flatMap(([bindings, label]) => {
    const bound = [
      ...new Set(bindings.flatMap((binding) => keys.getKeys(binding))),
    ];
    return bound.length
      ? [`${theme.fg("muted", bound.join(" "))} ${theme.fg("dim", label)}`]
      : [];
  });
  return hints.length ? ` ${hints.join(theme.fg("dim", " · "))}` : "";
}

function handleListInput(
  list: SelectList,
  ids: string[],
  keys: UIKeys,
  data: string,
  wrap = false,
): void {
  // SelectList reads module-global bindings, which may differ from Pi's injected manager.
  const selected = list.getSelectedItem();
  const index = ids.indexOf(selected?.value ?? "");
  const move = (delta: number) => {
    if (!ids.length) return;
    const next = index + delta;
    list.setSelectedIndex(wrap ? (next + ids.length) % ids.length : next);
  };
  if (keys.matches(data, "tui.select.up")) move(-1);
  else if (keys.matches(data, "tui.select.down")) move(1);
  else if (keys.matches(data, "tui.select.confirm")) {
    if (selected) list.onSelect?.(selected);
  } else if (keys.matches(data, "tui.select.cancel")) list.onCancel?.();
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
    private keys: UIKeys,
  ) {
    // Extension-loaded DynamicBorder cannot rely on Pi's global theme instance.
    this.border = new DynamicBorder((text) => this.theme.fg("border", text));
    this.list = this.createList(1);
  }

  private createList(maxVisible: number): SelectList {
    const selected = this.list?.getSelectedItem()?.value;
    const tasks = this.tasks().toReversed();
    const now = Date.now();
    const columns: TaskColumns = { prefix: 0, nameEnd: 0, result: 0, time: 0 };
    // Measure all tasks at one instant so columns stay stable while scrolling.
    for (const task of tasks) {
      const prefix = visibleWidth(
        `${statusIcons[statusColor(task)]} ${task.id}  `,
      );
      columns.prefix = Math.max(columns.prefix, prefix);
      columns.nameEnd = Math.max(
        columns.nameEnd,
        prefix + visibleWidth(oneLine(task.name)),
      );
      columns.result = Math.max(columns.result, visibleWidth(taskResult(task)));
      columns.time = Math.max(
        columns.time,
        visibleWidth(`󰔛 ${duration(task, now)}`),
      );
    }
    const byId = new Map(tasks.map((task) => [task.id, task]));
    this.ids = tasks.map((task) => task.id);
    const list = new SelectList(
      tasks.map((task) => ({ value: task.id, label: statusLine(task, now) })),
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
          return renderTaskLine(
            this.theme,
            task,
            maxWidth,
            isSelected ? "accent" : "text",
            now,
            columns,
          );
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
    handleListInput(this.list, this.ids, this.keys, data, true);
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
    const listHeight = Math.max(1, contentRows - 2);
    // Reserve a line for SelectList's scroll position when the tasks overflow.
    this.list = this.createList(Math.max(1, listHeight - 1));
    const content = [
      this.theme.fg("accent", "Background tasks"),
      ...margin,
      ...this.list.render(width).slice(0, listHeight),
      ...margin,
      renderHint(this.theme, this.keys, [
        [["tui.select.up", "tui.select.down"], "navigate"],
        [["tui.select.confirm"], "select"],
        [["tui.select.cancel"], "cancel"],
      ]),
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
    private theme: StatusTheme,
    private height: () => number,
    private renderRequest: () => void,
    private close: () => void,
    private keys: UIKeys,
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
    if (this.disposed) return;
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.dispose();
      this.close();
      return;
    }
    if (this.keys.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
    else if (this.keys.matches(data, "tui.select.down"))
      this.scroll.scrollBy(1);
    else if (this.keys.matches(data, "tui.select.pageUp"))
      this.scroll.scrollBy(-this.scroll.viewportHeight);
    else if (this.keys.matches(data, "tui.select.pageDown"))
      this.scroll.scrollBy(this.scroll.viewportHeight);
    else if (this.keys.matches(data, "tui.altScreen.top"))
      this.scroll.scrollToStart();
    else if (this.keys.matches(data, "tui.altScreen.bottom"))
      this.scroll.scrollToEnd();
    this.renderRequest();
  }

  private renderBorder(
    width: number,
    arrow: "↑" | "↓",
    hiddenRows: number,
  ): string {
    const rule = (length: number) =>
      this.theme.fg("border", "─".repeat(length));
    if (hiddenRows <= 0) return rule(width);
    // Pi's Editor keeps its count-border helper private; reuse ScrollView for
    // paging and mirror the border here without introducing an editable cursor.
    let label = ` ${arrow} ${hiddenRows} more `;
    if (visibleWidth(label) + 2 > width) label = ` ${arrow} ${hiddenRows} `;
    // Drop whole fields rather than truncate a count into a misleading number.
    if (visibleWidth(label) + 2 > width)
      label = width >= 3 ? ` ${arrow} ` : arrow;
    const remaining = width - visibleWidth(label);
    const left = Math.floor(remaining / 2);
    return rule(left) + this.theme.fg("muted", label) + rule(remaining - left);
  }

  render(width: number): string[] {
    if (this.disposed || width < 1) return [];
    const rows = Math.max(1, this.height());
    // Drop metadata and hints on short screens before sacrificing output rows.
    const header =
      rows >= 5
        ? [
            this.theme.fg("border", "─".repeat(width)),
            renderTaskLine(this.theme, this.task(), width, "accent"),
          ]
        : [];
    if (rows >= 7)
      header.push(
        this.theme.fg("muted", `Last 8 KiB: ${this.task().outputPath}`),
      );
    const hints =
      rows >= 6
        ? [
            renderHint(this.theme, this.keys, [
              [["tui.select.up", "tui.select.down"], "scroll"],
              [["tui.select.pageUp", "tui.select.pageDown"], "page"],
              [["tui.altScreen.top"], "top"],
              [["tui.altScreen.bottom"], "follow"],
              [["tui.select.cancel"], "back"],
            ]),
          ]
        : [];
    const framed = rows >= 3;
    const content = this.scroll.render(width);
    // Clip explicitly so this works in both regular and fullscreen Pi layouts.
    this.scroll.updateLayout(
      content.length,
      rows - header.length - hints.length - (framed ? 2 : 0),
      this.renderRequest,
    );
    const start = this.scroll.scrollTop;
    const end = start + this.scroll.viewportHeight;
    return [
      ...header,
      ...(framed ? [this.renderBorder(width, "↑", start)] : []),
      ...content.slice(start, end),
      ...(framed
        ? [this.renderBorder(width, "↓", Math.max(0, content.length - end))]
        : []),
      ...hints,
    ].map((line) => truncateToWidth(line, width));
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
              truncateToWidth(` ${renderCounts(theme, this.counts)}`, width),
            ];
          },
        };
      },
      { placement: "aboveEditor" },
    );
  }

  private async choose(
    ctx: ExtensionCommandContext,
    task: Task,
    options: string[],
    prompt = "",
  ): Promise<string | undefined> {
    try {
      return await ctx.ui.custom<string | undefined>(
        (tui, theme, keys, done) => {
          let closed = false;
          const finish = (value: string | undefined) => {
            if (closed) return;
            closed = true;
            done(value);
          };
          const createList = (maxVisible: number, selected?: string) => {
            const list = new SelectList(
              options.map((value) => ({ value, label: value })),
              maxVisible,
              {
                selectedPrefix: (text) => theme.fg("accent", text),
                selectedText: (text) => theme.fg("accent", text),
                description: (text) => theme.fg("muted", text),
                scrollInfo: (text) => theme.fg("dim", text),
                noMatch: (text) => theme.fg("muted", text),
              },
            );
            list.setSelectedIndex(Math.max(0, options.indexOf(selected ?? "")));
            list.onSelect = (item) => finish(item.value);
            list.onCancel = () => finish(undefined);
            return list;
          };
          let list = createList(1);
          const border = new DynamicBorder((text) => theme.fg("border", text));
          this.closeView = () => finish(undefined);
          return {
            handleInput(data: string) {
              if (closed) return;
              handleListInput(list, options, keys, data);
              tui.requestRender();
            },
            render: (width: number) => {
              if (closed || width < 1) return [];
              const height = viewHeight(tui.terminal.rows, 2);
              const borders = height >= 4 ? border.render(width) : [];
              const rows = height - 2 * borders.length;
              const margin = rows >= 6 ? [""] : [];
              const listHeight = Math.max(1, rows - 2 * margin.length - 2);
              list = createList(
                Math.max(1, listHeight - 1),
                list.getSelectedItem()?.value,
              );
              const prefix = prompt ? theme.fg("accent", prompt) : "";
              const content = [
                prefix +
                  renderTaskLine(
                    theme,
                    this.registry.get(task.id),
                    Math.max(0, width - visibleWidth(prefix)),
                    "accent",
                  ),
                ...margin,
                ...list.render(width).slice(0, listHeight),
                ...margin,
                renderHint(theme, keys, [
                  [["tui.select.up", "tui.select.down"], "navigate"],
                  [["tui.select.confirm"], "select"],
                  [["tui.select.cancel"], "back"],
                ]),
              ].slice(0, rows);
              return [...borders, ...content, ...borders].map((line) =>
                truncateToWidth(line, width),
              );
            },
            invalidate() {},
            dispose() {
              closed = true;
            },
          };
        },
      );
    } finally {
      this.closeView = undefined;
    }
  }

  async show(ctx: ExtensionCommandContext): Promise<void> {
    while (!this.disposed) {
      if (!this.registry.list().length) {
        ctx.ui.notify("No background tasks.", "info");
        return;
      }
      const selected = await ctx.ui.custom<string | undefined>(
        (tui, theme, keys, done) => {
          const view = new TaskListView(
            () => this.registry.list(),
            theme,
            () => viewHeight(tui.terminal.rows, 2),
            () => tui.requestRender(),
            done,
            keys,
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
      const action = await this.choose(ctx, task, [
        "View output",
        ...(task.status === "running" ? ["Kill"] : []),
        "Back",
      ]);
      if (this.disposed) return;
      if (action === "View output") {
        await ctx.ui.custom<void>((tui, theme, keys, done) => {
          const view = new OutputView(
            () => this.registry.get(task.id),
            theme,
            () => viewHeight(tui.terminal.rows),
            () => tui.requestRender(),
            () => done(),
            keys,
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
        // Default to No so repeated selection keys cannot accidentally kill a task.
        (await this.choose(
          ctx,
          task,
          ["No", "Yes"],
          "Kill background task? ",
        )) === "Yes"
      ) {
        if (this.disposed) return;
        try {
          await this.registry.stop(task.id, "user");
        } catch (error) {
          ctx.ui.notify(String(error), "error");
        }
      }
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
