# Contributing to @ikuma.cloud/pix-usage

Read the [repository contribution guide](../../CONTRIBUTING.md) before making
changes. See [README.md](README.md) for usage and limitations.

## Development

```sh
mise run usage:dev
mise run test --project pix-usage
mise run check
```

Tests must mock network and credential resolution and isolate Pi package loading
from personal configuration. Never use real subscription credentials in tests.
Use fake timers for widget refresh, countdown, and cleanup tests. Cover overlapping
manual/widget requests and late results after hiding, switching providers, or
replacing sessions. Live endpoint compatibility and terminal appearance require
separate manual checks.

## Design

- `src/index.ts` registers `/usage`, including its terminal-only `toggle` argument,
  and owns report delivery and the widget's lifecycle. Terminal `session_start`
  shows the widget by default; toggling can hide it until the next session.
  Loading the extension alone starts no resources, and non-terminal sessions never
  start automatic checks. Shutdown aborts outstanding work; late completions
  cannot update a replacement session.
- `src/requests.ts` shares in-flight provider checks between reports and the widget.
  Each consumer has independent cancellation; only the last consumer or shutdown
  cancels the underlying request. Do not cache completed results for later reports.
- `src/widget-controller.ts` follows provider selection and owns widget refreshes,
  countdown timers, and cancellation. `turn_end` triggers non-blocking checks with
  a one-minute cooldown, shared with fallback polling and measured using a
  monotonic clock. Count failed attempts too; skip throttled events without queuing
  retries. Initial display and provider changes stay immediate; manual reports
  bypass the widget cooldown. No timers or credential requests run while hidden
  or for unsupported providers. Pi component disposal must also stop work.
- `src/widget.ts` renders normalized state with a package-local divider, bounded
  terminal widths, and the live theme. Rendering must never start network work.
  `src/format.ts` keeps report/widget formatting rules consistent; report output
  remains unchanged.
- `src/auth.ts` adapts Pi's `getProviderAuth()` to the token-accepting fetchers.
  Pi owns OAuth refresh and persistence. Do not read or write credential files,
  invoke provider CLIs, or log credential-resolution errors.
- `src/providers.ts` validates and normalizes provider payloads without Pi imports.
  Missing quota windows or reset times are unknown, not zero usage or guessed resets.
- `src/http.ts` bounds requests and bodies, refuses redirects, and sanitizes errors.
  Never surface raw response bodies, tokens, JWT claims, or network errors.
- `src/report.ts` formats only normalized quota data and safe error messages. Keep
  account identity and arbitrary provider strings out of terminal output.

The implementation targets Pi 0.87.1. Use the public extension APIs documented in
[extensions](https://pi.dev/docs/latest/extensions) and
[packages](https://pi.dev/docs/latest/packages).

The HTTP interfaces are internal provider endpoints, not stable public APIs.
Request and payload references:
[Claude](https://github.com/steipete/CodexBar/blob/main/docs/claude.md),
[Codex](https://github.com/steipete/CodexBar/blob/main/docs/codex.md), and
[Pi's Codex request implementation](https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/api/openai-codex-responses.ts).
Keep these boundaries isolated so endpoint changes do not affect Pi integration.
