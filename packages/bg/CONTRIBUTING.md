# Contributing to pix-bg

Read the [root contribution guide](../../CONTRIBUTING.md) before making changes.

## Run locally

```sh
mise run bg:dev
```

This loads only pix-bg, avoiding tool and command collisions with
pi-background-tasks. No default keyboard shortcut is registered.

## Testing

```sh
mise run test --project pix-bg
mise run check
```

Tests launch local processes, never models. Process tests use temporary logs and
short cleanup grace periods. Keep the registry independent of Pi APIs; test
notification policy separately with fake timers. Extension integration tests load
through Pi's loader with isolated configuration.

Before release, check in interactive Pi that a short task wakes the agent,
`kill -KILL $$` reports signal 137, killing from `/bg` does not start a turn,
and `/reload` and quit leave no task processes. Check the output viewer at narrow
widths and after resizing.

## Implementation references

- [Pi extensions](https://pi.dev/docs/latest/extensions): lifecycle, messages, tools.
- [Pi TUI](https://pi.dev/docs/latest/tui): rendering and custom-component disposal.
- [Pi bash tool](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts): signal exit codes and bounded output.
- [Node child processes](https://nodejs.org/api/child_process.html): `exit` versus
  `close`, detached process groups, and pipe ownership.

Unlike daemon-oriented task systems, a task's shell owns its lifetime. Its exit
triggers process-group cleanup even when descendants still hold stdout/stderr.
Record a stop reason before signaling; a null exit code is never success.
