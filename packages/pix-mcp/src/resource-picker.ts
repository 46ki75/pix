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
import { resourceEntryKey, type ResourceEntry } from "./resources.ts";

function metadata(entry: ResourceEntry) {
  return entry.kind === "resource" ? entry.resource : entry.template;
}

function identifier(entry: ResourceEntry) {
  return entry.kind === "resource"
    ? entry.resource.uri
    : entry.template.uriTemplate;
}

function details(entry: ResourceEntry, theme: Theme): string {
  const item = metadata(entry);
  const title = compact(item.title ?? item.name, 120);
  const description = compact(item.description ?? "", 320);
  const uri = compact(identifier(entry), 500);
  const annotations = item.annotations;
  const hints = [
    ...(item.mimeType ? [`Type: ${compact(item.mimeType, 120)}`] : []),
    ...(entry.kind === "resource" && entry.resource.size !== undefined
      ? [`Size: ${entry.resource.size.toLocaleString("en-US")} bytes`]
      : []),
    ...(entry.kind === "template" && entry.variables.length > 0
      ? [
          `Variables: ${entry.variables.map((value) => compact(value, 80)).join(", ")}`,
        ]
      : []),
    ...(annotations?.audience?.length
      ? [`Audience: ${annotations.audience.slice(0, 2).join(", ")}`]
      : []),
    ...(annotations?.priority !== undefined
      ? [`Priority: ${annotations.priority}`]
      : []),
    ...(annotations?.lastModified
      ? [`Modified: ${compact(annotations.lastModified, 80)}`]
      : []),
  ];
  return [
    theme.fg("accent", theme.bold(title)),
    theme.fg(
      "muted",
      `${entry.kind === "template" ? "Template" : "Resource"}: ${uri}`,
    ),
    ...(description ? [theme.fg("muted", description)] : []),
    ...(hints.length > 0 ? [theme.fg("dim", hints.join(" • "))] : []),
  ].join("\n");
}

export function createResourcePicker(
  entries: ResourceEntry[],
  tui: TUI,
  theme: Theme,
  done: (result: string | undefined) => void,
  signal?: AbortSignal,
): Component & { dispose(): void } {
  const items: SelectItem[] = entries.map((entry) => {
    const item = metadata(entry);
    return {
      value: resourceEntryKey(entry),
      label: `${entry.server} / ${compact(item.title ?? item.name, 120)}`,
      description: compact(identifier(entry), 180),
    };
  });
  const entriesByKey = new Map(
    entries.map((entry) => [resourceEntryKey(entry), entry]),
  );
  const container = new Container();
  container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
  container.addChild(
    new Text(theme.fg("accent", theme.bold("Select MCP resource"))),
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

export async function pickResource(
  entries: ResourceEntry[],
  ctx: ExtensionCommandContext,
): Promise<ResourceEntry | undefined> {
  if (ctx.signal?.aborted) return;
  const selected = await ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) =>
      createResourcePicker(entries, tui, theme, done, ctx.signal),
  );
  if (selected === undefined) return;
  return entries.find((entry) => resourceEntryKey(entry) === selected);
}
