# @ikuma.cloud/pix-statusline

A customizable [Pi Coding Agent](https://pi.dev/) footer with compact model/context
metrics and Git-aware directory segments. Pi loads the TypeScript source directly;
no build step is required.

**Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.**

## Install

After the package is published to npm:

```sh
pi install npm:@ikuma.cloud/pix-statusline
```

Use a Nerd Font and disable any other extension that calls `setFooter()`.

## Try locally

After the [workspace setup](../../README.md#setup), run from the repository root:

```sh
mise run statusline:dev
```

This launches Pi with only this extension enabled. To load it alongside your
usual extensions without saving configuration:

```sh
pi -e ./packages/statusline
```

To keep using the local package:

```sh
pi install ./packages/statusline
```

## Layout

The footer is installed automatically in interactive terminal mode:

```text
󱘖 openai-codex  test-model (272k) 󱩔 high                    98.4% 󰓅 36.1% █▓░░
  pix/packages/statusline   main 
```

It retains the working directory, Git branch, optional session name, and status
messages from other extensions. The directory segment uses:

- Outside Git: ` ~/path` (paths outside your home remain absolute).
- Inside Git: ` repository-name/relative/path`, or ` repository-name` at the root.
  Linked worktrees use their own root directory name.

The directory and branch share the second row, using rounded Powerline segments:
a blue directory segment followed by a bright-blue branch segment prefixed with
``. The optional session name appears beside the branch, separated by `•`. If
neither is present, only the directory segment is rendered.

Use a Nerd Font in your terminal to display these icons. Git detection runs once
at session startup; use `/reload` after initializing or removing a repository.
If Git is unavailable or detection fails, the footer uses the folder format.

The first row places the selected provider/model and thinking level on the left,
with the latest assistant prompt's cache-hit rate and context utilization aligned
to the right: ` 98.4% 󰓅 36.1% █▓░░`. The context-window size appears beside the
model name, as in ` test-model (272k)`. The cache-hit rate uses the same theme
`dim` color as the model details. An unavailable cache-hit rate shows ` ?`.
Token counts, cache read/write totals, and cost are not displayed.
Extension status messages appear below the directory/branch row.

The context icon and percentage use terminal bright green (`ANSI.fg.brightGreen`).
The four-cell context bar uses `█` for each completed 25%, `▓` for a partially
filled cell, and `░` for empty cells. It starts bright green and retains its
yellow/red warning colors at higher usage:

| Context usage | Bar | Color |
| --- | --- | --- |
| ≤0% | `░░░░` | Bright green |
| >0% and <25% | `▓░░░` | Bright green |
| 25% | `█░░░` | Bright green |
| >25% and <50% | `█▓░░` | Bright green |
| 50% | `██░░` | Bright green |
| >50% and <75% | `██▓░` | Yellow |
| 75% | `███░` | Yellow |
| >75% and <100% | `███▓` | Red |
| ≥100% | `████` | Red |

This is a starting point, not an exact copy of Pi's built-in footer:

- Subscription `(sub)` and auto-compaction `(auto)` indicators are not included.
- Unknown context usage is shown as `?` without a bar, including after compaction.
  Unknown context-window sizes are shown as `(?)` beside the model.
- Cache-hit rate uses the latest recorded assistant prompt. Streaming usage
  appears once recorded.
- When the first row does not fit, the provider name and icon are hidden first,
  then the cache-hit rate and its icon. Both return when space allows. If the row
  still does not fit, its right end is truncated, potentially hiding context
  metrics. Other rows truncate as needed.
- RPC, JSON, and print modes are unchanged. Only one extension can own the footer;
  do not combine this with another `setFooter()` extension.

## Customize

Edit [`src/footer.ts`](src/footer.ts) to change the segments, spacing, or theme
colors, or [`src/location.ts`](src/location.ts) for directory formatting, then
run `/reload` in Pi. [`src/index.ts`](src/index.ts) owns session lifecycle
registration. There are no settings, environment variables, tools, commands,
or model requests added by this package.

### Thinking effort

The model suffix uses these icon/label pairs: `󰹐 off`, `󱩎 minimal`, `󱩐 low`,
`󱩒 medium`, `󱩔 high`, `󱩖 xhigh`, and `󰛨 max`. It updates with the current
thinking level and is omitted for non-reasoning models. If the runtime does not
provide a thinking level, the label defaults to `󰹐 off`.

Edit `THINKING_ICONS` in `src/footer.ts` to change the icons. This only changes
the display, not which thinking levels the selected model supports.

### ANSI colors

[`src/ansi.ts`](src/ansi.ts) exports a readonly `ANSI` map with 16 named colors
under `fg` and `bg`, plus `reset.fg`, `reset.bg`, and `reset.all`. Color names are
`black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, and `white`, with
bright variants such as `brightRed`. The `AnsiColor` type covers these names.

For example, inside `src/footer.ts`:

```ts
import { ANSI } from "./ansi.ts";

const icon = `${ANSI.fg.red}${ANSI.reset.fg}`;
const path = `${ANSI.fg.cyan}pix/packages/statusline${ANSI.reset.fg}`;
```

These colors follow your terminal's palette, not Pi's theme. Foreground and
background resets restore terminal defaults, not an enclosing theme color;
reapply theme colors to subsequent segments when needed. Use `reset.all` only
when you also want to clear other styling.

### Rounded and connected segments

[`src/powerline.ts`](src/powerline.ts) provides `powerline()` for a row with
rounded ends and arrow separators. Supply all connected segments in one call:

```ts
import { powerline } from "./powerline.ts";

const bar = powerline([
  { text: " pix/packages/statusline", background: "blue" },
  { text: " main", background: "brightBlue" },
]);
```

A single segment also gets rounded ends; no separate badge helper is needed.

Background colors are required; foreground defaults to `black`. Each segment
has one space of padding on each side. Embedded ANSI styling is stripped and
line breaks and tabs become spaces, keeping the segment's background intact.
The renderer restores terminal-default foreground and background colors afterward.

Use a Nerd Font for the ``, ``, and `` glyphs. The renderer returns a string;
use Pi's `visibleWidth()` and `truncateToWidth()` when placing it in the footer.
Truncation can remove the final rounded cap on narrow terminals.
