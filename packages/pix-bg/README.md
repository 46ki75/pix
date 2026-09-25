# @ikuma.cloud/pix-bg

Small background shell tasks for [Pi Coding Agent](https://pi.dev/), with
completion wake-ups, capped log files, and an interactive task viewer.
Version 0.0.8 targets macOS and Linux and is developed against Pi 0.87.1.

**Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.**

## Try locally

From the repository root:

```sh
mise run bg:dev
```

This launches Pi with only pix-bg. Before enabling it in normal sessions, remove
pi-background-tasks: both extensions register `bg_run`, `bg_status`, `bg_kill`,
and `/bg`. Do not load them together.

## Tools

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `bg_run` | `command`, optional `name` and `timeout` | Start a shell command; return ID, PID, and log path |
| `bg_status` | Optional `id` | Inspect one task or list the newest 50 tasks |
| `bg_kill` | `id` | Stop the task and return its final state |

IDs are exact, random identifiers, never intentionally reused across reloads.
`timeout` is in seconds; omitting it means no timeout. Use Pi's built-in `read`
tool to inspect the returned log path. Logs combine stdout and stderr; ordering
between the two streams depends on pipe delivery.

For example, ask Pi to run `sleep 2; echo done` with `bg_run`. Continue independent
work or end the turn; do not use blocking sleeps or poll status/logs to wait.
In interactive and RPC modes, natural exits, timeouts, and output-cap stops deliver
a follow-up message and start a turn without user input.
Completions within 250 ms are batched. Messages include outcomes, duration, log
paths, and bounded output tails. Signal termination is distinct from success:
`kill -KILL $$` reports `SIGKILL (exit code 137)`.

Stopping with `bg_kill` returns the outcome directly without another notification.
Stopping from `/bg` queues a next-turn message without waking the agent.

## Interactive UI

A two-line indicator appears above the input editor at session startup, even
before any tasks have run:

```text
──  Background Tasks ──────────────────────────────────────
  Running 0  Succeeded 0  Failed 0  Timeout 0  Killed 0
```

Use `/bg toggle` to hide or show the indicator. Hiding it does not stop tasks or
reset counts; `/bg` still opens the task viewer. Visibility resets to shown on
reload or session replacement.

The title divider fills the available width; the counts line starts with one
space. The `` icon uses the theme's `muted` color. Divider lines use `borderMuted`,
heading text and status labels use `dim`, and numeric counts use `text`. Each
status icon uses the color below; blue is approximated in 256-color terminals.
Theme colors refresh when the theme changes, and both lines are truncated on
narrow terminals. Unless hidden, counts remain visible while idle. They reset on
reload or session replacement and are not restored from history. Commands that
fail to launch are not counted.

`/bg` lists detailed outcomes with the same colored status icons as the indicator,
without repeating its legend. Use a Nerd Font to display these icons:

| Status | Icon color | Meaning |
| --- | --- | --- |
|  Running | Blue `#68779f` | Still running or cleaning up |
|  Succeeded | Theme `success` | Exit code 0 |
|  Failed | Theme `error` | Nonzero exit, signal, or execution error |
|  Timeout | Theme `warning` | Timeout or output limit reached |
|  Killed | Theme `muted` | Intentionally stopped by the user, agent, or shutdown |

Task-list rows, menu titles, and output-view headers share a compact summary.
The task list aligns outcomes and durations across entries:

```text
→  5f2e2ed719c9  computation-smoke-test 󰐦 0 󰔛 0.1s
   a2cdec80d7cc  runtime-smoke-test     󰐦 0 󰔛 0.0s
```

`` marks the task name, `󰐦` precedes the exit code, and `󰔛` precedes elapsed
time. Signals retain their names, such as `󰐦 137 (SIGKILL)`; tasks without an
exit code show their status or reason instead. These summaries prioritize IDs,
outcomes, and durations over long task names. Columns stay stable while scrolling;
narrow terminals truncate names or drop alignment padding to preserve details.

Status and theme colors refresh while the list is open, without moving your
selection when another task starts. The navigation hint is indented by one space
and separated from the task rows by a blank line. Short viewports reduce spacing
and prioritize task rows. Navigation wraps between the first and last tasks;
action and confirmation menus stop at their boundaries. Select a task to view
output or kill a running task after confirmation, which defaults to No.

The output viewer starts with a full-width separator above its header. It shows
the last 8 KiB between scroll-indicator dividers and refreshes once per second
while the task runs. Like Pi's input editor, the dividers show centered counts
such as `── ↑ 4 more ──` and `── ↓ 12 more ──` when content is hidden in that
direction. Counts refer to wrapped display rows within the loaded tail, not the
entire log file. Narrow terminals omit `more`, then the count, keeping the arrow
rather than showing a partial number. Short viewports reduce metadata and
decoration to preserve output.
Views reserve six rows for the indicator, Pi's spacer and default footer, and one
transcript row. Below nine terminal rows, Pi's minimum editor height can still
clip the surrounding indicator or footer.
Jumping to the bottom resumes following the tail. Read the log file for older
output. No global shortcut is registered. The viewer is interactive-only; tools
also work in RPC, JSON, and print modes.

### Keybindings

All views use Pi's semantic keybindings. Hints show the configured keys and omit
disabled actions; the extension does not add hardcoded aliases or change Pi's
configuration.

| Behavior | Pi actions | Default keys |
| --- | --- | --- |
| Navigate lists or scroll output | `tui.select.up`, `tui.select.down` | Up, Down |
| Select a task or menu item | `tui.select.confirm` | Enter |
| Cancel or return to the task list | `tui.select.cancel` | Esc, Ctrl+C |
| Page through output | `tui.select.pageUp`, `tui.select.pageDown` | Page Up, Page Down |
| Jump to the start or follow output | `tui.altScreen.top`, `tui.altScreen.bottom` | Home, End |

For Vim-style selection keys, merge these entries into Pi's `keybindings.json`
(`~/.pi/agent/keybindings.json` by default), then run `/reload`:

```json
{
  "tui.select.up": ["up", "k"],
  "tui.select.down": ["down", "j"],
  "tui.select.confirm": ["enter", "l"],
  "tui.select.cancel": ["escape", "ctrl+c", "h", "q"]
}
```

These settings apply wherever Pi uses the same actions, not just `/bg`. See
[Pi's keybinding reference](https://pi.dev/docs/latest/keybindings) for details.

## Output cap

`PIX_BG_MAX_OUTPUT_BYTES` sets the per-task stored-output cap. It must be a
positive safe integer; the default is **104857600 bytes (100 MiB)**. Exceeding
it stops the task with an `output_capped` outcome. ANSI escape sequences and
unsafe control characters are stripped before storage. The byte cap may split
a final UTF-8 character.

Logs are stored with owner-only file permissions under
`os.tmpdir()/pi-bg-<uid>/<session-id>/<task-id>.log`. The private parent is
namespaced by OS user so that Linux users sharing `/tmp` do not block one another.
Existing parent and session directories must belong to that user, have no group
or other permissions, and not be symlinks; unsafe paths are rejected, not repaired.
Logs remain after tasks finish and after reload so that result paths stay useful.
Remove old logs yourself; they may contain sensitive command output. Task metadata
in tool results and completion-message `details` remains in the session, but the
live registry is not reconstructed from history.

## Lifecycle and limits

- Pi owns detached process groups directly. There is no tmux backend or daemon.
  Stopping sends SIGTERM, then SIGKILL after a two-second grace period if needed.
- A task ends with its shell. When the shell exits, remaining processes in its
  group are terminated, including children that still hold output pipes open.
  Commands must not daemonize, call `setsid`, or otherwise escape their group.
- Every shutdown, reload, new session, resume, or fork stops current tasks.
  Shutdown suppresses completion notifications. Tasks do not survive `/reload`.
  Tree navigation within the same runtime does not recreate or rewind processes.
- Print/JSON invocations (`pi -p` / `pi --mode json`) do not wait for background
  tasks or wake an idle agent. They stop remaining tasks when the invocation ends.
- A Pi crash or SIGKILL can orphan processes. There is no watchdog; use the
  recorded PID/process group to inspect and clean up manually.
- Commands inherit Pi's environment and working directory and run through Pi's
  default shell configuration, with stdin disconnected. There is no sandbox,
  interactive prompt handling, concurrency limit, or automatic log retention.
- Windows and reload survival are not supported in v0.0.8.

## Release

After merging the reviewed changes, tag `bg-v0.0.8` and publish the package from
`packages/pix-bg` manually. The repository has no automated publish workflow.
