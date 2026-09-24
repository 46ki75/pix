# Contributing to @ikuma.cloud/pix-statusline

Read the [repository contribution guide](../../CONTRIBUTING.md) before making
changes. See [README.md](README.md) for usage and limitations.

## Develop and test

From the repository root:

```sh
mise run statusline:dev
mise run test --project pix-statusline
mise run check
```

The development task disables other extensions to avoid competing footer owners.
It accepts Pi arguments, for example `mise run statusline:dev --offline`.
Tests load the package with an isolated agent directory, exercise all run modes,
and check usage accounting, live data, terminal widths, and subscription cleanup
without model requests. Location tests use temporary Git repositories with user
Git configuration disabled, including linked worktrees and symlinked paths.
Actual terminal appearance still needs a manual check.

## Implementation

- `src/index.ts` resolves the directory label and installs the footer on
  `session_start` in TUI mode, then clears it on shutdown. Pi disposes replaced
  footer components.
- `src/location.ts` probes Git once per session start with a one-second timeout,
  falling back to a home-relative folder label on failure. Keep subprocess and
  filesystem work out of rendering.
- `src/footer.ts` contains usage collection and rendering, including one
  connected directory/branch row. Omit empty metadata segments. Use public
  extension APIs rather than importing Pi's internal footer implementation.
- `src/powerline.ts` composes connected segments with rounded outer ends using
  `src/ansi.ts`. Keep its tests independent of the footer's layout and verify
  cap/transition colors, resets, and compatibility with Pi's width helpers.
- Keep rendered rows within their supplied width using Pi TUI helpers. Read
  current metrics and apply theme colors during rendering so changes are visible
  without retaining stale usage or theme snapshots.
- The Git branch listener belongs to the component and is released by `dispose()`.
  No polling, timers, or network requests are needed.

The extension targets Pi 0.87.1. References:
[extensions](https://pi.dev/docs/latest/extensions),
[terminal UI](https://pi.dev/docs/latest/tui),
[packages](https://pi.dev/docs/latest/packages), and the official
[`custom-footer.ts` example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/custom-footer.ts).
