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

## Execution boundary

`src/execution.ts` defines the internal executor contract. `Registry` owns task
IDs, snapshots, stop reasons, timeouts, output decoding, capped logs, and completion
notifications to subscribers. `PosixExecutor` owns shell spawning, process-group
signaling, escalation, and pipe draining; neither layer imports Pi APIs. The
extension entry point selects the executor and passes it to the registry.

An executor returns a handle synchronously, including its PID and a `ready`
promise. Observer callbacks must run after that return so the registry can own a
still-launching task during shutdown. `ready` resolves only after launch is
acknowledged; spawn failures are reported to the observer before it rejects.

Shell exit and execution completion are separate events. Output can arrive after
exit, and stdout/stderr must remain distinct for incremental decoding. Completion
is reported once, only after output closure and descendant cleanup, including
output closure after a failed launch. The registry can then close the log and
resolve stop/shutdown requests without closing a log still receiving output.
Stopping initiates cleanup; it does not imply completion. Signal-delivery errors
must remain visible and cleanup must remain retryable.

`registry-executor.test.ts` checks registry policy with an injected executor.
`posix-execution.test.ts` checks the backend contract; `registry-lifecycle.test.ts`
retains deterministic OS-event ordering and signaling regressions. The real-process
and extension integration suites remain the end-to-end checks. New backends must
satisfy the contract; changing lifecycle guarantees requires a separate decision.

## Implementation references

- [Pi extensions](https://pi.dev/docs/latest/extensions): lifecycle, messages, tools.
- [Pi TUI](https://pi.dev/docs/latest/tui): rendering and custom-component disposal.
- [Pi bash tool](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts): signal exit codes and bounded output.
- [Node child processes](https://nodejs.org/api/child_process.html): `exit` versus
  `close`, detached process groups, and pipe ownership.

Unlike daemon-oriented task systems, a task's shell owns its lifetime. Its exit
triggers process-group cleanup even when descendants still hold stdout/stderr.
Record a stop reason before signaling; a null exit code is never success.
