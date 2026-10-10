# @ikuma.cloud/pix-usage

Claude, Codex, Meta Muse, OpenCode Go, and GitHub Copilot quota reports and a
current-provider widget for [Pi Coding Agent](https://pi.dev/). Uses Pi's existing
OAuth logins and an OpenCode API key, not a separate credential store or usage SDK.

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

Sign in through `/login anthropic`, `/login openai-codex`, `/login meta`, or
`/login github-copilot`, choosing the subscription/OAuth flow rather than an API
key. Copilot currently supports github.com logins, not custom enterprise hosts.
For OpenCode Go, use `/login opencode-go` to save its API key. Then run:

```text
/usage          Check all providers
/usage claude   Check Claude only
/usage codex    Check Codex only
/usage muse     Check Meta Muse only
/usage opencode Check OpenCode Go only
/usage copilot  Check GitHub Copilot only
/usage all      Check all providers
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

Quota labels, usage values, relative resets, and UTC timestamps are column-aligned
across successful rows in a report. Percent-only values have a minimum width of
three characters before `%`, with no truncation. Copilot amounts and percentages
are aligned as one value. In terminal mode, percentages above 75% use the active
theme's `error` color; those
above 50% through 75% use `warning`. Thresholds use unrounded usage; values at or
below 50% keep their existing color.

Relative times are calculated when the notification is created, not updated live.
Durations use days, hours, and whole minutes. Hours and minutes are right-aligned
to two characters (for example, `4d 14h  8m`); zero-valued units remain omitted.
The relative-time column is right-aligned to the widest countdown in the report,
with a minimum width of ten characters, so shorter countdowns such as `4h 59m` do
not shift the UTC timestamp left.
Sub-minute intervals show `<1m`. Past timestamps show `ago`, and an exact match
shows `now`; neither confirms that the provider has refreshed the quota. Unknown
resets show `-d --h --m` without a date. Precise resets use
`YYYY-MM-DD HH:mm:ss (UTC)`; calendar-only resets use `YYYY-MM-DD (time unknown)`
without a countdown or timezone. Fractional seconds and checked timestamps are
omitted from the report.

Use a Nerd Font to display the icons: `` for OpenAI/Codex, `` for Claude,
`󰛤` for Meta Muse, `󰨔` for OpenCode Go, `` for GitHub Copilot, `` for
five-hour windows, `󱛡` for weekly windows (including model-specific weekly
limits), `󰸗` for OpenCode's monthly window, `󰓅` for usage, `` for resets,
and `󱘖` for the report title.
Other or unknown durations have no window icon. In terminal mode, provider icons
use the active theme's `accent` color, and window, usage, and reset icons use `text`.
The dividers enclose all provider sections and use `border`; other text keeps Pi's
informational notification color (`dim`). RPC reports contain no ANSI colors.
Icons are added only when rendering reports and widgets; the reusable fetchers
return plain labels.

### Copilot credit and request counts

Copilot reports a single chat-related quota: Free accounts use `chat`; other
accounts prefer `premium_interactions`, falling back to `chat` when premium is
absent or unallocated. Overlapping categories are never summed; inline completion
quotas are not displayed.

```text
 Copilot

  AI credits 󰓅 420 / 1,500 credits (28%)         22d 2026-11-01 00:00:00 (UTC)
```

The denominator is the API's quota entitlement, not a hardcoded plan allowance
or a guarantee that those credits are included in your subscription. It can
reflect an organization-assigned budget. Used amounts come from
`entitlement - quota_remaining`; when the remaining counter is absent, the amount
is estimated from the reported percentage and prefixed with `≈`. The percentage
remains the provider-reported ratio. Amounts use US digit grouping and up to two
decimal places; small positive amounts below 0.01 show `<0.01` instead of zero.
Legacy request-billed accounts show `Premium` or `Chat` and request units instead.

Uncapped accounts can report an aggregate credit count without a denominator:
`420 credits used · limit unavailable`. Without a count, the row shows
`No individual limit reported`. An explicitly unavailable pooled quota is labeled
`quota unavailable`, even if historical usage is reported. Missing limits never
imply zero consumption or unlimited access to a shared organization pool.

The reset uses the category's reported epoch, falling back to the account reset
when the category value is absent or zero. Account dates without a clock remain
visible as `2026-11-01 (time unknown)`, without inventing midnight, a timezone, or a
countdown. A month length or next reset is never inferred. Overage spend,
additional-usage budgets, and session/weekly rate limits are not part of this
indicator.

### Current-provider widget

A compact widget appears above the editor by default in terminal sessions:

```text
── 󱘖 Usage ─────────────────────────────────────────────────────────────────────
  Codex 󱛡 Weekly 󰓅  93%  9h 39m 2026-09-30 22:59:59 (UTC)
```

Run `/usage toggle` to hide it, or again to show it. This choice applies only to
the current session; reload or session replacement shows the widget again.
Other extensions' widget order is not controlled.

It follows the selected model's provider: `anthropic` selects Claude,
`openai-codex` selects Codex, `meta` selects Muse, `opencode-go` selects
OpenCode Go, and `github-copilot` selects Copilot. It shows one row per normalized
quota window, including model-specific buckets; it does not filter those buckets
to the selected model.
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
**used**, with the same thresholds and icons as reports. Multi-window results align
labels, percentages, countdowns, and timestamps by visible width. A past reset is
not proof that the provider has refreshed the quota.

Loading, missing-login, empty-quota, and error states appear in the widget, not as
repeated notifications or fabricated zero usage. A failed refresh replaces the old
quota display. Hiding the widget stops automatic refreshes and cancels requests
unless an overlapping manual report still needs them.

Precise resets show the relative countdown followed by `YYYY-MM-DD HH:mm:ss (UTC)`
when the entire row fits. On narrower terminals, the absolute timestamp is omitted
as a unit, keeping the countdown. Calendar-only resets show
`YYYY-MM-DD (time unknown)` instead of a countdown. Each row adapts independently
when resized; unknown resets never add a date.

The divider fills the available terminal width; content rows have a one-space
indent. If a row is still too long without its timestamp, it is truncated. The
widget uses the current theme on every render,
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

For Claude and Codex, the extension calls
`ctx.modelRegistry.getProviderAuth()` with `anthropic` or `openai-codex` and uses
the resolved OAuth access token. Pi owns token refresh and persistence. API keys
and missing logins produce a per-provider message; externally supplied tokens
classified as API keys are intentionally not used.

OpenCode Go accepts only a literal API key saved through `/login opencode-go`.
The extension uses Pi's side-effect-free auth-status API and reads that stored
value directly. Saved command values are rejected. OpenCode checks deliberately
do not call Pi's model-auth resolver, so configured model headers and their
commands are not resolved. Before the request, the extension reads the source and
key twice and verifies twice that no extension has replaced `opencode-go` and
every effective provider and model URL is a known first-party OpenCode Go URL.
Environment, runtime, `models.json`, and extension fallback keys are refused. The
extension does not read OpenCode's own files or forward custom model headers.
OpenCode Zen (`opencode`) remains a separate pay-as-you-go provider and does not
activate the widget.

Meta's quota-bearing key-mint endpoint rejects the derived `LLM|` inference key
exposed by Pi's model registry. Muse first uses the side-effect-free
`getProviderAuthStatus("meta")` check to require a stored login, then uses Pi's
public `readStoredCredential()` API to read the `meta` OAuth credential from Pi's
existing `auth.json` and select its `dca:` device identity token. It correlates the
stored inference key with `getProviderAuth("meta")` so a custom credential store or
concurrent login cannot silently query another account. If Pi refreshes that key
during resolution, the check asks the user to retry instead of making a second
call to the same key-mint endpoint. The extension does not modify or refresh the
credential itself. Muse CLI files, browser cookies, and the Keychain are not read.
A custom Pi API key, Meta dashboard key, Muse inference key, or separate Muse CLI
login is not used.

Copilot requires an OAuth credential saved through `/login github-copilot` in
Pi's standard CLI credential store. It uses side-effect-free auth status and
`readStoredCredential()` to read only that provider. Pi stores the GitHub OAuth
token in `refresh` and the derived inference token in `access`; only the former
is sent to `GET https://api.github.com/copilot_internal/user`. This does not
refresh or mint inference tokens, call the model-auth resolver, or read `gh`,
Copilot CLI, browser, or Keychain credentials. Environment/API keys and runtime
or extension fallback credentials are refused.

Copilot validates the stored issuer and effective first-party provider/model
routes before sending. Custom enterprise-host logins, malformed issuer metadata,
provider replacements, and proxy routes are refused. Credential identity and
routing are rechecked before sending, before a timeout retry, and after the
response; changed logins or routing require a fresh check. Custom SDK stores and
auth paths are outside its scope, and Pi does not expose historical routing
provenance after an override is removed.

Quota requests target only fixed first-party HTTPS endpoints, and redirects are
refused. Codex's account ID is decoded from the access token for the
`chatgpt-account-id` routing header, matching Pi's Codex transport. OpenCode sends
its API key only to `GET https://opencode.ai/zen/go/v1/usage`. Muse sends the
device token only to `POST https://api.meta.ai/muse-code/key`, with an empty JSON
body and API version `1.0.0`; the minted inference key, payment metadata, email, and
plan in the response are discarded. The extension does not forward custom model
headers or use model endpoint overrides.

HTTP requests have a 15-second timeout covering the response body and a 256 KiB
response limit. Claude and Codex timeouts are retried once without resolving
credentials again. Copilot timeouts are retried once after rechecking routing and
the saved credential, without resolving model authentication. Before retrying an
OpenCode timeout, the extension rechecks its routing, credential source, and key,
then reuses the unchanged key. Muse's quota-bearing key-mint POST is not retried,
and a Pi credential refresh is never followed by another mint in the same check.
Each provider check has a 35-second total deadline, including credential lookup
and request attempts.
Network, authentication, rate-limit, HTTP, and response errors are not retried.
Shutdown, reload, and session replacement cancel HTTP work and suppress late UI
updates. Pi-managed credential refresh may finish after the extension stops
waiting; the extension does not interfere with Pi's refresh lock.

## Limitations

- The HTTP endpoints are internal interfaces and may change without notice.
  See the [implementation references](CONTRIBUTING.md#design).
- Claude displays reported 5-hour, weekly, Sonnet-weekly, and Opus-weekly buckets.
  Usage access requires the `user:profile` OAuth scope. A subscription login does
  not guarantee that the provider permits the usage endpoint.
- Codex displays the primary and secondary windows with their reported durations.
  It does not assume the primary window is always five hours.
- Muse displays the subscription window using its reported duration and the weekly
  window as seven days. Meta can omit `subs_usage` while the five-hour window is
  idle; this appears as “No quota windows reported.” The extension does not use a
  browser session or guess the omitted weekly value.
- Muse quota lookup calls Meta's key-mint endpoint, which issues an inference key;
  the extension discards that key rather than persisting or using it.
- OpenCode reports the Go subscription's five-hour, weekly, and monthly windows.
  It does not report Zen pay-as-you-go balance, monetary usage, local history,
  model-specific effective allowances, or whether balance fallback is enabled.
  The API key is read before each check; if it changes while a request is in
  flight, the prior key's quota may remain visible until the next refresh. Pi
  stores `/login` credentials by provider ID without recording the endpoint. If
  `opencode-go` previously targeted a proxy, clear or replace that credential
  before restoring the built-in provider; the extension cannot identify a stale
  proxy key after the override is removed. Active endpoint and provider
  replacements are refused. Only Pi's standard CLI credential store is supported;
  custom SDK registry stores and auth paths are outside this extension's scope.
- Copilot billing mode and quota availability vary by account. Live-account
  compatibility requires separate validation beyond the mocked test suite.
  The oldest Free payload format without `quota_snapshots` is not supported. A successful quota check is not a guarantee of model access.
- Beyond Copilot's displayed quota counts, the extension does not request
  reset-credit inventory, credit balances, spending, or Codex's
  additional/model-scoped quota buckets. Meta's required key-mint
  response can contain payment and plan metadata; those fields are discarded and
  never displayed. The extension does not reproduce the entire provider billing
  page.
- Optional Claude and Codex windows are omitted when absent. OpenCode responses
  require all three Go windows, valid status and percentage fields, and
  timezone-bearing reset timestamps. Muse may omit the entire `subs_usage` object,
  but when it is present both `window` and `weekly` are required; a missing one is
  malformed data. Absent, nonpositive, or unrepresentable Muse reset times remain
  unknown. Other malformed payload data is an error, not zero usage. Each provider
  succeeds or fails independently.
- These are account-level provider quota measurements, not a count of tokens
  consumed by the current Pi session or a guarantee about how Pi requests are billed.
- JSON and print modes do not fetch quotas or resolve credentials through this
  command. RPC clients must support Pi's UI notifications to show the report.
- Only one login per provider is resolved, as selected by Pi. There is no account
  switcher or cross-account aggregation.

## Reusable fetchers

[`src/providers.ts`](src/providers.ts) has no Pi dependency. Its
`fetchClaudeUsage(accessToken, options?)`,
`fetchCodexUsage(accessToken, options?)`,
`fetchMuseUsage(identityToken, options?)`,
`fetchOpenCodeUsage(apiKey, options?)`, and
`fetchCopilotUsage(githubToken, options?)` functions accept credentials and return
normalized `UsageSnapshot` values. Options allow an abort signal, timeout, and
injected `fetch` for tests. Codex expects the same account-bearing JWT used by Pi;
Muse requires the `dca:` device identity token, not an `LLM|` inference key.
OpenCode requires an API key for a workspace with a Go subscription. Copilot
requires a github.com OAuth token, not a Copilot inference token or enterprise
credential. Its normalized windows can carry exact or estimated amounts;
`usedPercent: null` means that no meaningful ratio was reported, never zero.
A calendar-only reset is returned as `resetsOn: "YYYY-MM-DD"` with `resetsAt: null`;
only `resetsAt` represents a timestamp suitable for a countdown.
Pure parsers and normalized types are separate from credential resolution and UI
formatting. Keep credential ownership in the calling application.
