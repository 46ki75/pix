# @ikuma.cloud/pix-theme-inspector

An on-demand semantic color inspector for Pi Coding Agent's terminal UI.

**Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.**

## Usage

From the repository root:

```sh
mise run theme-inspector:dev
```

In Pi, run:

```text
/theme-colors
```

The command prints the active theme's name, color mode, and all 56 terminal color
tokens supported by Pi 0.87.1: 49 foreground colors and 7 background colors.
Tokens are grouped by role, with a color preview, the effective color value, and
a short description of where the color is used. Values are shown as:

- `#rrggbb`: the RGB color emitted by Pi.
- `index N`: an ANSI palette index, not an assumed RGB value.
- `terminal default`: the terminal's own foreground or background color.
- `unknown "..."`: an unrecognized escape sequence, shown as a diagnostic instead
  of applied as a color.

Foreground token names use their own colors, including intentionally dim or
low-contrast colors. Background swatches use spaces inside brackets.
Background token names, color values, and descriptions use the theme's normal
text color.
The report wraps with the terminal width and is scrollable like other Pi output.

## Behavior and limitations

- Requires Pi's TUI. RPC receives a warning; print and JSON modes do not render a
  report. No arguments or configuration are required.
- Reads the active theme on every invocation without changing it. Optional token
  fallbacks are already resolved by Pi; this is not a dump of the original JSON.
- Reports the ANSI colors Pi emits. In 256-color mode, RGB theme values have
  already been approximated. Indexed colors, terminal defaults, and actual
  appearance depend on your terminal palette and contrast settings.
- Output is a snapshot: rerun after switching or editing a theme. Consecutive
  notifications may replace the previous report. Reports are not saved as
  session entries or sent to the model, and do not trigger an agent turn.
- Does not include HTML-export-only colors, edit themes, or make network requests.
- Developed against Pi 0.87.1. New token names require a package update.

To load the local package from another working directory, use
`pi --no-extensions -e /absolute/path/to/packages/pix-theme-inspector`.
