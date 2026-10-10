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
  `src/format.ts` keeps report/widget formatting rules consistent. Keep widget
  rows compact; report rows align labels, percentages, relative resets, and UTC
  timestamps by visible terminal width.
- `src/auth.ts` adapts Pi's authentication APIs to the token-accepting fetchers.
  Pi owns OAuth resolution, refresh, and persistence. Claude and Codex require
  OAuth from `getProviderAuth()`. OpenCode Go accepts only a literal Pi credential
  saved through `/login opencode-go`. Require Pi's side-effect-free auth status to
  identify a stored credential, then read it directly and twice before
  transmission. Reject saved credential commands and do not call the model-auth
  resolver for OpenCode: that could execute unused configured-header commands.
  Also verify twice that no extension replaced `opencode-go` and every effective
  provider/model URL is a known first-party URL. Reject environment, runtime,
  `models.json`, and extension fallback keys. Document that Pi does not expose
  historical endpoint provenance for a saved key after a provider override is
  removed. This integration supports Pi's standard CLI credential store; custom
  SDK registry stores and auth paths are outside its scope. Never read OpenCode's
  own credential files or forward model headers or endpoint overrides.
  Meta also needs its stored identity token: its quota endpoint rejects Pi's
  derived inference key, so use the side-effect-free `getProviderAuthStatus()`
  check and read only the
  `meta` OAuth device token through Pi's public `readStoredCredential()` API.
  Correlate the stored inference key with `getProviderAuth("meta")` to fail closed
  on credential-store or login races. If resolution refreshes Meta through the
  key-mint endpoint, require a retry rather than minting again. Do not write
  credential files, inspect unrelated credentials, invoke provider CLIs, or log
  credential-resolution errors.
- `src/copilot-auth.ts` reads only the stored `github-copilot` OAuth credential,
  using Pi's side-effect-free auth status and public credential reader. Pi's
  `refresh` field is the GitHub token; `access` is the derived inference token.
  Do not call the model-auth resolver: quotas need neither model headers nor
  inference-token refresh. Require the built-in provider, allowlisted first-party
  model routes, and absent or exactly `github.com` issuer metadata. Recheck copied
  credential/routing values before transmission, retry, and accepting a response.
  Fail closed on enterprise hosts, overrides, malformed metadata, or login races.
  Only the standard CLI store is supported; status plus file reads cannot prove
  custom SDK store identity or historical endpoint provenance.
- `src/providers.ts` validates and normalizes provider payloads without Pi imports.
  Provider-declared optional quota windows and reset times are unknown, not zero
  usage or guessed resets. OpenCode Go requires rolling, weekly, and monthly
  windows with valid status, percentage, and reset fields. Muse may omit
  `subs_usage`, but if it is present both `window` and `weekly` are required. Its
  nonpositive or unrepresentable reset epochs are unknown; retain the otherwise
  valid window. Copilot Free accounts use chat, including when a placeholder
  premium bucket omits its zero entitlement. Other accounts prefer premium quota
  and fall back to chat when it is absent or unallocated. Never sum overlapping
  buckets. Choose units from top-level `token_based_billing`. For a finite allowance, subtract
  `quota_remaining` from `entitlement`, or explicitly mark a percentage-derived
  estimate. `credits_used` is a separate aggregate without a denominator, not the
  numerator for `entitlement`. Unknown ratios are null and must render without
  a percentage. A zero finite entitlement is unallocated, not exhausted; unlimited
  snapshots can still have an unavailable shared pool. Prefer per-category reset
  epochs; a zero category epoch is absent and must not suppress the account
  fallback, matching VS Code's `quota_reset_at || undefined` normalization.
  Preserve validated date-only account resets in `resetsOn` with `resetsAt: null`.
  Render the calendar date with an unknown-time label, never a guessed midnight,
  timezone conversion, or countdown. Keep raw identities, plan strings, overage
  metadata, and unused buckets out of normalized results.
- `src/http.ts` bounds requests and bodies, refuses redirects, and sanitizes errors.
  `src/auth.ts` retries safe quota reads, including OpenCode's GET, once only for
  timeouts. Recheck OpenCode routing and credential identity before retrying, then
  reuse the unchanged token. Copilot's GET also retries a timeout only once and
  revalidates credentials/routing before retrying. Do not retry Meta's key-mint POST.
  Never surface raw response bodies, tokens, JWT claims, or network errors.
- `src/report.ts` formats only normalized quota data and safe error messages. Keep
  account identity and arbitrary provider strings out of terminal output.

The implementation targets Pi 0.87.1. Use the public extension APIs documented in
[extensions](https://pi.dev/docs/latest/extensions) and
[packages](https://pi.dev/docs/latest/packages).

The HTTP interfaces are internal provider endpoints, not stable public APIs.
Request and payload references:
[Claude](https://github.com/steipete/CodexBar/blob/main/docs/claude.md),
[Codex](https://github.com/steipete/CodexBar/blob/main/docs/codex.md),
[Muse](https://github.com/steipete/CodexBar/blob/main/docs/muse.md),
[OpenCode Go endpoint](https://github.com/anomalyco/opencode/blob/7945de208964a49300d7f770d1a71d078db9a4c4/packages/console/app/src/routes/zen/go/v1/usage.ts),
[OpenCode Go limits](https://opencode.ai/docs/go#usage-limits),
[Pi's OpenCode Go provider](https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/providers/opencode-go.ts),
[Pi's Codex request implementation](https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/api/openai-codex-responses.ts),
[Pi's Meta OAuth implementation](https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/auth/oauth/meta.ts),
[Pi's Copilot OAuth implementation](https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/auth/oauth/github-copilot.ts),
[VS Code quota normalization](https://github.com/microsoft/vscode/blob/959031245ebb1fe077e0d512e1397c0ae82006e4/src/vs/workbench/services/chat/common/chatEntitlementService.ts#L817-L1031),
[VS Code quota requests](https://github.com/microsoft/vscode/blob/959031245ebb1fe077e0d512e1397c0ae82006e4/extensions/copilot/src/platform/authentication/node/copilotTokenManager.ts#L340-L352),
and [GitHub billing terminology](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing).
Keep these boundaries isolated so endpoint changes do not affect Pi integration.
