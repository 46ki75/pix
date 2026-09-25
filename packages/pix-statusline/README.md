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
pi -e ./packages/pix-statusline
```

To keep using the local package:

```sh
pi install ./packages/pix-statusline
```

## Layout

The footer is installed automatically in interactive terminal mode:

```text
 󱘖 openai-codex  test-model 272k 󱩔 high                    98.4%  36.1% █▓░░

  pix/packages/pix-statusline   main                                      
```

It retains the working directory, Git branch, optional session name, and status
messages from other extensions. The directory segment uses:

- Outside Git: ` ~/path` (paths outside your home remain absolute).
- Inside Git: ` repository-name/relative/path`, or ` repository-name` at the root.
  Linked worktrees use their own root directory name.

A blank row separates the model/usage line from the directory/branch line.
The directory/branch row uses rounded Powerline segments with fixed RGB colors:

| Segment | Background | Foreground |
| --- | --- | --- |
| Directory | `#bda68b` | `#40444c` |
| Branch/session | `#c6b5a2` | `#393e46` |
| Filler | `#cabfb2` | `#31353a` |

The branch is prefixed with ``. The optional session name appears beside it,
separated by `•`. If neither is present, the branch segment is omitted.
Foreground colors apply to labels and icons; caps and separators match the
segment backgrounds.

When space allows, the filler segment fills the rest of the row after another
``, ending in `` at the right edge. This filler is omitted on narrow terminals
rather than shortening labels. Long labels are truncated before the final space
and cap. These fixed foreground and background colors require a truecolor
terminal for exact colors and do not follow Pi's theme.

Use a Nerd Font in your terminal to display these icons. Git detection runs once
at session startup; use `/reload` after initializing or removing a repository.
If Git is unavailable or detection fails, the footer uses the folder format.

The first row has one space of padding at each end. It places the selected
provider/model and thinking level on the left, with the latest assistant prompt's
cache-hit rate and context utilization aligned to the right: ` 98.4%  36.1% █▓░░`.
The context-window size follows the model name, as in ` test-model 272k`.
Provider, model, and thinking-effort icons use the theme's primary UI color
(`accent` in Pi's API). The cache-hit icon `` uses `text`. Provider/model names,
thinking-level labels, and cache-hit values (including `----`) use `muted`.
The context-window size and cache-hit `%` sign use `dim`.
An unavailable cache-hit rate shows ` ----%`.
Token counts, cache read/write totals, and cost are not displayed.
Extension status messages appear below the directory/branch row.

The context icon, percentage, and gauge share the same color: terminal bright
green through 50%, yellow above 50%, and red above 75%. Unknown usage stays
bright green without a gauge. The four-cell gauge uses `█` for each completed
25%, `▓` for a partially filled cell, and `░` for empty cells:

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
- Unknown context usage is shown as ` ----%` without a bar, including after
  compaction. Unknown context-window sizes are shown as `?` after the model name.
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
const path = `${ANSI.fg.cyan}pix/packages/pix-statusline${ANSI.reset.fg}`;
```

These colors follow your terminal's palette, not Pi's theme. Foreground and
background resets restore terminal defaults, not an enclosing theme color;
reapply theme colors to subsequent segments when needed. Use `reset.all` only
when you also want to clear other styling.

For fixed RGB colors, `colorCode("fg", "#40444c")` and
`colorCode("bg", "#bda68b")` from `src/ansi.ts` emit 24-bit truecolor sequences.
The `TerminalColor` type accepts named ANSI colors or six-digit `#RRGGBB` hex
colors; invalid hex values throw an error. Hex colors are independent of the
terminal palette and Pi's theme; no 256-color fallback is applied.

### Rounded and connected segments

[`src/powerline.ts`](src/powerline.ts) provides `powerline()` for a row with
rounded ends and arrow separators. Supply all connected segments in one call:

```ts
import { powerline } from "./powerline.ts";

const bar = powerline([
  { text: " pix/packages/pix-statusline", background: "#bda68b", foreground: "#40444c" },
  { text: " main", background: "#c6b5a2", foreground: "#393e46" },
  { text: "", background: "#cabfb2", foreground: "#31353a" },
]);
```

A single segment also gets rounded ends; no separate badge helper is needed.
Pass an optional width, such as `powerline(segments, width)`, to fill the row.
The final visible segment is padded or truncated before its rounded cap, using
that segment's background color. Later segments are omitted if an earlier label
fills the available space. Without a width, labels are not padded to fill a row
or truncated.

Background colors are required; foreground defaults to `black`. Both accept
named ANSI colors or six-digit hex colors, including mixed palettes. A foreground
callback can apply theme colors, such as `(text) => theme.fg("text", text)` using
the footer factory's `theme`. It runs after padding, sanitization, and truncation,
and must preserve the visible text and background color.

Segments have space padding on both sides, except at extremely narrow widths.
Embedded ANSI styling is stripped from labels, and line breaks and tabs become
spaces, keeping the segment's background intact. The renderer restores
terminal-default foreground and background colors afterward.

Use a Nerd Font for the ``, ``, and `` glyphs. The renderer returns a string
that fits the supplied width, preserving both rounded caps whenever at least
two columns are available.
