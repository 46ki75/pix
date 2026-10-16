// Pi 1.0+ uses Sign in with ChatGPT on openai, not the legacy Codex grant.
// These tokens target api.openai.com/v1 and have opaque auth metadata, not a
// chatgpt_account_id. No quota route is documented for this grant; never send it
// to the legacy backend-api/wham/usage endpoint or substitute another login.
// https://developers.openai.com/siwc/token-sharing-open-source/token-reference
// https://developers.openai.com/siwc/ui-ux-guidelines#link-to-chatgpt-usage
export const OPENAI_USAGE_UNAVAILABLE = {
  provider: "openai",
  status: "unavailable",
  message:
    "ChatGPT plan quotas: https://chatgpt.com/settings/usage (no supported quota API).",
} as const;
