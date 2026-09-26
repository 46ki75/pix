# @ikuma.cloud/pix-usage

Claude and Codex subscription quota reports and a current-provider widget
for [Pi Coding Agent](https://pi.dev/). Uses Pi's existing OAuth login, not a
separate credential store or usage SDK.

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
/usage toggle   Hide or show the current-provider widget (terminal only)
```

### Reports

Report commands work in interactive terminal and RPC UI modes. They display a Pi
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
long reports on narrow terminals. Reports always use an informational notification,
so provider failures do not add a `Warning: ` prefix or recolor the whole report.
Missing-login and error messages appear on an indented line beneath the provider
heading, like quota rows. In terminal mode, missing logins use `warning` and failed
requests or credential resolution use `error`; other providers keep their normal
colors.

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
informational notification color (`dim`). RPC reports contain no ANSI colors.
Icons are added only when rendering reports and widgets; the reusable fetchers
return plain labels.

### Current-provider widget

A compact widget appears above the editor by default in terminal sessions:

```text
── 󱘖 Usage ─────────────────────────────────────────────────────────────────────
 Codex 󱛡 Weekly 󰓅  93%  9h 39m 2026-09-30 22:59:59 (UTC)
```

Run `/usage toggle` to hide it, or again to show it. This choice applies only to
the current session; reload or session replacement shows the widget again.
Other extensions' widget order is not controlled.

It follows the selected model's provider: `anthropic` selects Claude and
`openai-codex` selects Codex. It shows one row per reported quota window, including
model-specific buckets; it does not filter those buckets to the selected model.
Other providers and an absent model show an explanatory message without resolving
credentials or making requests.

The widget fetches immediately when first shown, including at session startup,
and whenever its provider changes while visible. Switching models within the
same provider does not trigger a fetch.

After each `turn_end`, it refreshes if at least one minute has passed since its
last refresh attempt. A five-minute fallback poll uses the same cooldown. Failed
attempts also count, and turns during the cooldown are skipped rather than queued.
The hook starts the check without waiting for network work or delaying the next
turn. Manual `/usage` reports bypass the widget cooldown.

Reset countdowns update locally every minute without fetching. Percentages are
**used**, with the same thresholds and icons as reports. A past reset is not proof
that the provider has refreshed the quota.

Loading, missing-login, empty-quota, and error states appear in the widget, not as
repeated notifications or fabricated zero usage. A failed refresh replaces the old
quota display. Hiding the widget stops automatic refreshes and cancels requests
unless an overlapping manual report still needs them.

Known resets show the relative countdown followed by `YYYY-MM-DD HH:mm:ss (UTC)`
when the entire row fits. On narrower terminals, the absolute timestamp is omitted
as a unit, keeping the countdown. Each row adapts independently when resized;
unknown resets never add a date.

The divider fills the available terminal width. If a row is still too long without
its timestamp, it is truncated. The widget uses the current theme on every render,
including after an idle theme change. It requires terminal mode; RPC users can
still use the report commands.

## Behavior

The extension does not replace the footer, add model-callable tools, send model
requests, or save quota reports in model context or session history. Reports remain
on-demand. Automatic credential lookups and quota requests begin at terminal
session startup and continue only while the widget is visible for a supported
provider. RPC, JSON, and print modes never start automatic checks.

Concurrent manual reports are rejected. Overlapping widget and report checks
share in-flight work for the same provider, but completed results are not cached
for later reports. Repeat `/usage` for a fresh snapshot.

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
response limit. Each provider check has a 20-second total deadline, including
credential resolution. Shutdown, reload, and session replacement cancel HTTP work
and suppress late UI updates. Pi-managed credential refresh may finish after the
extension stops waiting; the extension does not interfere with Pi's refresh lock.

## Limitations

- The HTTP endpoints are internal interfaces and may change without notice.
  See the [implementation references](CONTRIBUTING.md#design).
- Claude displays reported 5-hour, weekly, Sonnet-weekly, and Opus-weekly buckets.
  Usage access requires the `user:profile` OAuth scope. A subscription login does
  not guarantee that the provider permits the usage endpoint.
- Codex displays the primary and secondary windows with their reported durations.
  It does not assume the primary window is always five hours.
- The extension does not fetch reset-credit inventory, credit balances, spending,
  or Codex's additional/model-scoped quota buckets. It does not reproduce the
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
UI formatting. Keep credential ownership in the calling application.
