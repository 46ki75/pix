import {
  DynamicBorder,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  Text,
  type Component,
  type SelectItem,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { compact } from "./catalog.ts";
import { promptKey, type PromptEntry } from "./prompts.ts";

function details(entry: PromptEntry, theme: Theme): string {
  const title = compact(entry.prompt.title ?? "", 120);
  const description = compact(entry.prompt.description ?? "", 320);
  return [
    ...(title ? [theme.fg("accent", theme.bold(title))] : []),
    theme.fg(
      description ? "muted" : "dim",
      description || "No description provided.",
    ),
  ].join("\n");
}

export function createPromptPicker(
  entries: PromptEntry[],
  tui: TUI,
  theme: Theme,
  done: (result: string | undefined) => void,
  signal?: AbortSignal,
): Component & { dispose(): void } {
  const items: SelectItem[] = entries.map((entry) => ({
    value: promptKey(entry.server, entry.prompt.name),
    label: `${entry.server} / ${entry.prompt.name}`,
  }));
  const entriesByKey = new Map(
    entries.map((entry) => [promptKey(entry.server, entry.prompt.name), entry]),
  );
  const container = new Container();
  container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
  container.addChild(
    new Text(theme.fg("accent", theme.bold("Select MCP prompt"))),
  );

  const list = new SelectList(items, Math.min(items.length, 10), {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  });
  container.addChild(list);

  const focusedDescription = new Text("", 1, 1);
  const updateDescription = (item: SelectItem) => {
    const entry = entriesByKey.get(item.value);
    if (entry) focusedDescription.setText(details(entry, theme));
  };
  const initialItem = items[0];
  if (initialItem) updateDescription(initialItem);
  list.onSelectionChange = updateDescription;
  container.addChild(focusedDescription);
  container.addChild(
    new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")),
  );
  container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

  let finished = false;
  const finish = (result: string | undefined) => {
    if (finished) return;
    finished = true;
    done(result);
  };
  list.onSelect = (item) => finish(item.value);
  list.onCancel = () => finish(undefined);
  const onAbort = () => finish(undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  return {
    render(width: number) {
      return container.render(width);
    },
    invalidate() {
      container.invalidate();
    },
    handleInput(data: string) {
      list.handleInput(data);
      tui.requestRender();
    },
    handleMouse(event: TuiMouseEvent) {
      const result = container.handleMouse(event);
      if (result?.render) tui.requestRender();
      return result;
    },
    dispose() {
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export async function pickPrompt(
  entries: PromptEntry[],
  ctx: ExtensionCommandContext,
): Promise<PromptEntry | undefined> {
  if (ctx.signal?.aborted) return;
  const selected = await ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) =>
      createPromptPicker(entries, tui, theme, done, ctx.signal),
  );
  if (selected === undefined) return;
  return entries.find(
    (entry) => promptKey(entry.server, entry.prompt.name) === selected,
  );
}
