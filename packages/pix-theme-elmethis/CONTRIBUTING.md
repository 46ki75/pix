# Contributing

Read and follow the [root contribution guide](../../CONTRIBUTING.md) before
making changes. Shared setup and validation commands are documented there.

## Theme files

- `themes/elmethis-dark.json` and `themes/elmethis-light.json` are standalone Pi
  themes, copied from the personal `ikuma-dark` and `ikuma-light` themes. Only
  their names changed during packaging; do not depend on personal dotfile paths
  or symlinks.
- The palette follows [Elmethis core tokens](https://github.com/46ki75/elmethis/blob/main/packages/core/src/style/token.ts).
  Translucent CSS colors are already composited into opaque hex values for Pi.
  Preserve those values unless intentionally changing the palette. The separate
  `ikuma-theme` VS Code/Shiki package uses a different palette.
- Keep filenames and JSON `name` fields aligned. Both variants share Pi color-role
  assignments and export mappings; only palette values differ.
- Use [Pi's theme format](https://pi.dev/docs/latest/themes). Tests read the schema
  shipped with the pinned development version and require all current color roles,
  including optional ones. Keep variable references valid in `colors` and `export`.
- Keep the published payload limited to `themes/` and npm's automatic metadata
  and README. No runtime code, dependencies, or generated artifacts are needed.

## Verification

```sh
mise run test --project pix-theme-elmethis
mise run theme-elmethis:dev
mise run check
```

Tests validate palette references, variant consistency, and discovery through both
package settings and command-line package paths. They use temporary agent and
working directories, with no personal configuration or model requests.

For a manual smoke test, try both variants with regular and fullscreen TUI modes,
including Markdown, tool diffs, search highlighting, and HTML export. Automated
tests do not assess visual contrast or terminal appearance notifications.

Before publishing, confirm the release version is not already published and
inspect the packed contents. The manifest enables public npm publication;
publishing is a separate, explicit step.
