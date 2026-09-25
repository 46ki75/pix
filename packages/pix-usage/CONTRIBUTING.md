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
Live endpoint compatibility and terminal appearance require separate manual checks.

## Design

- `src/index.ts` registers `/usage` and owns cancellation and notification delivery.
  No work starts until the command runs. Shutdown aborts outstanding work; late
  completions cannot notify a replacement session.
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
