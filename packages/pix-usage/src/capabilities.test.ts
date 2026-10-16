import { expect, test } from "vitest";
import { getUsageCapability } from "./capabilities.ts";

test.each([
  ["anthropic", "claude"],
  ["openai-codex", "codex"],
  ["meta", "muse"],
  ["opencode-go", "opencode"],
  ["github-copilot", "copilot"],
])("maps %s to the implemented %s usage fetcher", (providerId, provider) => {
  expect(getUsageCapability(providerId)).toEqual({
    status: "supported",
    provider,
  });
});

test("new OpenAI logins have a distinct unsupported capability, not a missing integration or fetch error", () => {
  expect(getUsageCapability("openai")).toEqual({
    provider: "openai",
    status: "unsupported",
    message:
      "Usage fetching is not supported for this OpenAI login; no supported quota API is currently known. https://chatgpt.com/settings/usage",
  });
});

test.each(["custom-provider", "google", "opencode", "toString", "__proto__"])(
  "classifies %s as unimplemented without claiming its API is unsupported",
  (providerId) => {
    expect(getUsageCapability(providerId)).toEqual({
      status: "unimplemented",
      message: "Usage fetching is not implemented for this provider.",
    });
  },
);

test("an absent model needs neither a fetcher nor a capability warning", () => {
  expect(getUsageCapability(undefined)).toEqual({ status: "no-model" });
});
