# @ikuma.cloud/pix-theme-elmethis

Dark and light [Elmethis](https://github.com/46ki75/elmethis) themes for
[Pi Coding Agent](https://pi.dev/). These are the personal `ikuma-dark` and
`ikuma-light` Pi themes, renamed without changing their palettes or color-role
assignments. They use Elmethis core design tokens, not the separate VS Code/Shiki
Ikuma Theme palette.

**Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.**

## Try locally

From this repository:

```sh
mise run theme-elmethis:dev
```

This loads the package for one invocation and selects automatic light/dark mode
without changing your saved theme setting. To choose one variant:

```sh
mise run theme-elmethis:dev --use-theme elmethis-dark
mise run theme-elmethis:dev --use-theme elmethis-light
```

For a persistent local installation, run from the repository root:

```sh
pi install ./packages/pix-theme-elmethis
```

Once published, the npm installation command will be:

```sh
pi install npm:@ikuma.cloud/pix-theme-elmethis
```

## Select a theme

Choose `elmethis-dark` or `elmethis-light` in `/settings`. To follow your terminal's
appearance, set this in `~/.pi/agent/settings.json` (light first, dark second):

```json
{
  "theme": "elmethis-light/elmethis-dark"
}
```

If migrating from the personal themes, replace `ikuma-dark` and `ikuma-light` in
your theme setting with the new names. Existing personal theme files can remain;
their names do not collide with this package.

The package contains only JSON themes: no extensions, runtime dependencies,
build step, or changes to your terminal's own color scheme. Automatic switching
depends on terminal appearance reporting. Run `/reload` after editing or updating
package themes; package files are not hot-reloaded like personal theme files.
