# @ikuma.cloud/pix-bg

Small background shell tasks for [Pi Coding Agent](https://pi.dev/), with
completion wake-ups, capped log files, and an interactive task viewer.
Version 0.0.4 targets macOS and Linux and is developed against Pi 0.87.1.

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

After the first task starts, a one-line indicator appears below the editor,
above Pi's existing footer:

```text
| ⏺ Running: 2 ⏺ Finished: 8 | /bg → Show BG Tasks |
```

Running includes tasks still stopping and uses blue `#68779f` (approximated in
256-color terminals). Finished includes every terminal outcome, not just success,
and uses the theme's `muted` color; separators and the hint use `dim`. Theme colors
refresh when the theme changes, and the line is truncated on narrow terminals.
Finished counts remain visible while idle and reset on reload or session
replacement; they are not restored from history. Commands that fail to launch
are not counted.

`/bg` lists detailed outcomes with a colored `⏺` before each task ID and a matching
legend below the list:

| Legend | Dot color | Meaning |
| --- | --- | --- |
| Running/stopping | Blue `#68779f` | Still running or cleaning up |
| Succeeded | Theme `success` | Exit code 0 |
| Failed | Theme `error` | Nonzero exit, signal, or execution error |
| Timeout/cap | Theme `warning` | Timeout or output limit reached |
| Killed | Theme `muted` | Intentionally stopped by the user, agent, or shutdown |

Rows prioritize IDs, outcomes, and durations over long task names. Status and
theme colors refresh while the list is open, without moving your selection when
another task starts. The legend wraps on narrow terminals; very
short viewports prioritize task rows. Use Up/Down or j/k to navigate, Enter to
select, and Esc/Ctrl+C to cancel. Select a task to view output or kill a running
task after confirmation. The footer keeps its simpler Running/Finished totals.

The output viewer shows the last 8 KiB and refreshes once per second while the
task runs. Use Up/Down, Page Up/Page Down, Home/End, and Esc. End resumes following
the tail. Read the log file for older output. No keyboard shortcut is registered.
The viewer is interactive-only; tools also work in RPC, JSON, and print modes.

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
- Windows and reload survival are not supported in v0.0.4.

## Release

After merging the reviewed changes, tag `bg-v0.0.4` and publish the package from
`packages/bg` manually. The repository has no automated publish workflow.
