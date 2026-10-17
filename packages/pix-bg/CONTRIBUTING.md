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
mise run bg:test-portable
mise run check
```

Tests launch local processes, never models. Process tests use temporary logs and
short cleanup grace periods. Keep the registry independent of Pi APIs; test
notification policy separately with fake timers. Extension integration tests load
through Pi's loader with isolated configuration.

`bg:test-portable` selects the fake-executor registry, formatting, notification,
and UI tests through an explicit allowlist in the root `mise.toml`. It runs on
Windows CI without loading a process backend. Its registry fixtures also mock
POSIX directory validation; the full suite retains real directory-security tests.
Add new platform-independent tests to that allowlist when appropriate; do not use
it instead of the full suite. Windows CI also runs `mise run test --project pix-bg`
for native Job Object execution, directory ACLs, and shared extension integration.
POSIX-only regression files remain enabled on macOS/Linux; Windows substitutes
native backend and ACL coverage rather than changing their assertions.

Before release, check in interactive Pi that a short task wakes the agent,
`kill -KILL $$` reports signal 137, killing from `/bg` does not start a turn,
and `/reload` and quit leave no task processes. On Windows, check a nonzero native
exit instead of a POSIX signal, and verify that killing the reported supervisor PID
also removes descendants. Run the Windows smoke test as a normal user in Windows
Terminal; hosted CI runs as an administrator. Check the output viewer at narrow
widths and after resizing.

## Execution boundary

`src/execution.ts` defines the internal executor contract. `Registry` owns task
IDs, snapshots, stop reasons, timeouts, output decoding, capped logs, and completion
notifications to subscribers. `PosixExecutor` owns shell spawning, process-group
signaling, escalation, and pipe draining. `WindowsExecutor` coordinates a bundled
PowerShell/C# supervisor with a kill-on-close Windows Job Object; its reported PID
belongs to that supervisor. Neither backend imports Pi APIs. The extension entry
point selects the executor and passes Pi's discovered Bash configuration to it.

An executor returns a handle synchronously, including its PID and a `ready`
promise. Observer callbacks must run after that return so the registry can own a
still-launching task during shutdown. `ready` resolves only after launch is
acknowledged; spawn failures are reported to the observer before it rejects.

Shell exit and execution completion are separate events. Failed launches disappear
from public tasks immediately but remain shutdown-owned until completion; repeated
disposal must permit retrying failed stop delivery. Output can arrive after exit,
and stdout/stderr must remain distinct for incremental decoding. Completion
is reported once, only after output closure and descendant cleanup, including
output closure after a failed launch. The registry can then close the log and
resolve stop/shutdown requests without closing a log still receiving output.
Stopping initiates cleanup; it does not imply completion. Signal-delivery errors
must remain visible and cleanup must remain retryable. Registry-triggered timeout,
output-cap, and output-error stops must contain delivery exceptions at the callback
boundary; explicit stop/shutdown calls still surface them. Internal errors are
retained as `Task.lastError` and sent to the error reporter without replacing the
first stop reason or closing logs before executor completion.

`registry-executor.test.ts` checks registry policy with an injected executor.
`posix-execution.test.ts` checks the backend contract; `registry-lifecycle.test.ts`
retains deterministic OS-event ordering and signaling regressions.
`registry-windows.test.ts` integrates the real Registry and Windows executor with
mocked OS events to verify emitted/thrown delivery failures across automatic and
explicit stop routes. The real-process and extension integration suites remain
the end-to-end checks. New backends must satisfy the contract; changing lifecycle
guarantees requires a separate decision.

On Windows, `windows-runner.cs` atomically associates the command with its job at
creation using `PROC_THREAD_ATTRIBUTE_JOB_LIST`; never replace this with a racy
spawn-then-assign sequence. Job handles are not inherited by commands. Control
frames travel over a private named pipe, independently of raw stdout/stderr.
`ready` means the command is job-contained, not merely that PowerShell started.
Windows cancellation is forceful and must not be represented as POSIX signals.
Direct stop-delivery errors remain synchronous; queued launch-time stop failures
must reach the error observer without escaping an event callback or preventing a
later retry. Pass the original command environment explicitly so the PowerShell
helper's module search path and execution policy do not leak into commands.
Git Bash requires MSYS argument encoding rather than CRT encoding; retain native
literal-backslash/quote regressions and reject WSL shell configurations. Snapshot
the command environment before acquiring supervisor resources and reject explicit
`MSYS` startup-glob options and quoted option strings rather than guessing their
runtime-specific token boundaries. The no-glob startup parser does not decode our
backslash escapes; never silently rewrite commands.
`windows-runtime.test.ts` uses IPC-ready process trees to prove descendant cleanup,
including natural shell exit, timeout, output cap, shutdown, and supervisor death.
Its negative control verifies that descendants survive root exit without pix-bg,
so libuv's own child cleanup cannot conceal a broken backend. Fallback cleanup
must join process exit before deleting working directories on Windows.
Keep `.ps1`/`.cs` helpers in the packed artifact and verify them on native Windows.
Filesystem security is independent: the Windows directory helper creates private
ACLs atomically and rejects unsafe existing paths without modifying them.

## Implementation references

- [Pi extensions](https://pi.dev/docs/latest/extensions): lifecycle, messages, tools.
- [Pi TUI](https://pi.dev/docs/latest/tui): rendering and custom-component disposal.
- [Pi bash tool](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts): signal exit codes and bounded output.
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects): ownership, inheritance, and kill-on-close cleanup.
- [Windows process attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute): atomic job association and restricted handle inheritance.
- [Node child processes](https://nodejs.org/api/child_process.html): `exit` versus
  `close`, detached process groups, and pipe ownership.

Unlike daemon-oriented task systems, a task's shell owns its lifetime. Its exit
triggers group/job cleanup even when descendants still hold stdout/stderr.
Record a stop reason before signaling; a null exit code is never success.
