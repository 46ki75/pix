# @ikuma.cloud/pix-usage

On-demand Claude and Codex subscription quotas for [Pi Coding Agent](https://pi.dev/).
Uses Pi's existing OAuth login, not a separate credential store or usage SDK.

**Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes.**

## Try locally

After the [workspace setup](../../README.md#setup), run:

```sh
mise run usage:dev
```

Or load it alongside your usual extensions without saving configuration:

```sh
pi -e ./packages/pix-usage
```

To keep using the local package:

```sh
pi install ./packages/pix-usage
```

## Usage

Sign in through `/login anthropic` or `/login openai-codex`, choosing the
subscription/OAuth flow rather than an API key. Then run:

```text
/usage          Check both providers
/usage claude   Check Claude only
/usage codex    Check Codex only
/usage all      Check both providers
```

The command works in interactive terminal and RPC UI modes. It displays a Pi
notification, with percentages **used**, absolute reset times in UTC, and time
remaining until each reset:

```text
── 󱘖 Usage ─────────────────────────────────────────────

 Claude

   5-hour 󰓅   0%  -d --h --m
  󱛡 Weekly 󰓅   0%  5d 16h 31m 2026-09-30 23:00:00 (UTC)

────────────────────────────────────────────────────────
```

Report dividers match the longest visible content line, with a minimum width for
the `󱘖 Usage` heading. Their width does not depend on terminal size; Pi may wrap
long reports on narrow terminals. If any provider is unavailable or fails, the
report is a warning notification, and Pi's TUI adds its native `Warning: ` prefix
before the header.

Percentage values are right-aligned to a minimum width of three characters,
without truncating longer values. In terminal mode, percentages above 75% use the
active theme's `error` color; those above 50% through 75% use `warning`. Thresholds
use unrounded usage; values at or below 50% keep their existing color.

Relative times are calculated when the notification is created, not updated live.
Durations use days, hours, and whole minutes. Hours and minutes are right-aligned
to two characters (for example, `4d 14h  8m`); zero-valued units remain omitted.
The relative-time column is right-aligned to a minimum width of ten characters,
so shorter countdowns such as `4h 59m` do not shift the UTC timestamp left.
Sub-minute intervals show `<1m`. Past timestamps show `ago`, and an exact match
shows `now`; neither confirms that the provider has refreshed the quota. Unknown
resets show `-d --h --m` without a date. Known dates use `YYYY-MM-DD HH:mm:ss (UTC)`;
fractional seconds and checked timestamps are omitted from the report.

Use a Nerd Font to display the icons: `` for OpenAI/Codex, `` for Claude,
`` for five-hour windows, `󱛡` for weekly windows (including model-specific
weekly limits), `󰓅` for usage, `` for resets, and `󱘖` for the report title.
Other or unknown durations have no window icon. In terminal mode, provider icons
use the active theme's `accent` color, and window, usage, and reset icons use `text`.
The dividers enclose all provider sections and use `border`; other text keeps Pi's
notification color. RPC reports contain no ANSI colors.
Icons are added only when formatting notifications; the reusable fetchers return
plain labels.

It does not replace the footer, add model-callable tools, send model requests,
or save quota reports in model context or session history. No work happens at
startup; there is no automatic polling, caching, or retry. Repeat `/usage` for a
fresh snapshot. Concurrent checks are rejected rather than duplicated.

## Credentials and requests

The extension calls `ctx.modelRegistry.getProviderAuth()` using `anthropic` and
`openai-codex`. Pi owns token refresh and persistence. Only resolved OAuth access
tokens are accepted; API keys and missing logins produce a per-provider message.
Externally supplied tokens classified as API keys are intentionally not used.

Tokens are sent only to the matching first-party HTTPS usage endpoint; redirects
are refused. Codex's account ID is decoded from the access token for the
`chatgpt-account-id` routing header, matching Pi's Codex transport. The extension
never reads credential files, refresh tokens, browser cookies, or the Keychain.
It does not forward custom model headers or use model endpoint overrides.

HTTP requests have a 15-second timeout covering the response body and a 256 KiB
response limit. Each command has a 20-second total deadline, including credential
resolution. Shutdown, reload, and session replacement cancel HTTP work and
suppress late notifications. Pi-managed credential refresh may finish after the
extension stops waiting; the extension does not interfere with Pi's refresh lock.

## Limitations

- The HTTP endpoints are internal interfaces and may change without notice.
  See the [implementation references](CONTRIBUTING.md#design).
- Claude displays reported 5-hour, weekly, Sonnet-weekly, and Opus-weekly buckets.
  Usage access requires the `user:profile` OAuth scope. A subscription login does
  not guarantee that the provider permits the usage endpoint.
- Codex displays the primary and secondary windows with their reported durations.
  It does not assume the primary window is always five hours.
- This first version does not fetch reset-credit inventory, credit balances,
  spending, or additional/model-scoped quota buckets. It does not reproduce the
  entire provider billing page.
- Missing windows are omitted; absent reset times remain unknown. Malformed
  payloads are errors, not zero usage. Each provider succeeds or fails independently.
- These are account-level provider quota measurements, not a count of tokens
  consumed by the current Pi session or a guarantee about how Pi requests are billed.
- JSON and print modes do not fetch quotas or resolve credentials through this
  command. RPC clients must support Pi's UI notifications to show the report.
- Only one login per provider is resolved, as selected by Pi. There is no account
  switcher or cross-account aggregation.

## Reusable fetchers

[`src/providers.ts`](src/providers.ts) has no Pi dependency. Its
`fetchClaudeUsage(accessToken, options?)` and
`fetchCodexUsage(accessToken, options?)` functions accept access tokens and return
normalized `UsageSnapshot` values. Options allow an abort signal, timeout, and
injected `fetch` for tests. Codex expects the same account-bearing JWT used by Pi.
Pure parsers and the normalized types are separate from credential resolution and
notification formatting. Keep credential ownership in the calling application.
