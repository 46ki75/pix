# Contributing

Read and follow the [root contribution guide](../../CONTRIBUTING.md) before
making changes. Shared setup and validation commands are documented there and
in the [root README](../../README.md).

## Implementation

- `src/tokens.ts` is an exhaustive, grouped catalog of `ThemeColor` and the
  background parameter type derived from `Theme["bg"]`. Each token has a group
  and a short description summarizing Pi's theme schema. Update the catalog and
  its tests when upgrading Pi. Do not enumerate private `Theme` fields or
  deep-import Pi internals at runtime.
- `src/colors.ts` recognizes Pi's single-sequence foreground/background SGR
  output. Preserve indexed and terminal-default values rather than inventing
  RGB equivalents. Unknown sequences must be escaped, not replayed.
- `src/report.ts` formats the snapshot. Foreground token names use their own
  colors; background names, values, and descriptions use normal text. Pi wraps notifications
  in its `dim` foreground, so restore that ambient color after every row. Leave
  width-dependent wrapping to Pi's native `Text` component so terminal resizes
  do not require rerunning the command.
- `src/index.ts` registers `/theme-colors` and gates theme access on TUI mode.
  Keep it notification-only: no tools, session entries, or model requests.

The versioned [theme source](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/modes/interactive/theme/theme.ts)
and [schema](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/modes/interactive/theme/theme-schema.json)
are the reference for token names, fallbacks, and emitted ANSI sequences.

## Verification

```sh
mise run test --project pix-theme-inspector
mise run typecheck
mise run theme-inspector:dev
```

Tests must remain independent of personal Pi configuration and credentials.
Use real `Theme` fixtures for color resolution and the native `Text` component
for width and resize checks. Keep an isolated package-loader test.

For a manual smoke test, run `/theme-colors` with both built-in themes and both
TUI modes, then resize the terminal and rerun after a theme change. The dev task
accepts `--use-theme light` and `--tui-mode fullscreen`. On supported terminals,
`PI_TRUE_COLOR=1` or `PI_TRUE_COLOR=0` can exercise color modes; Pi's terminal
settings take precedence over these environment variables.

Check that all tokens appear once, foreground names use their token colors
without recoloring values or descriptions, background defaults retain visible
brackets, and no agent turn starts. Run the root `mise run check` before
submitting changes.
