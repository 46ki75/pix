import { OPENAI_USAGE_UNSUPPORTED } from "./openai.ts";
import type { UsageProvider } from "./types.ts";

export type UsageCapability =
  | { status: "supported"; provider: Exclude<UsageProvider, "openai"> }
  | typeof OPENAI_USAGE_UNSUPPORTED
  | { status: "unimplemented"; message: string }
  | { status: "no-model" };

export function getUsageCapability(
  providerId: string | undefined,
): UsageCapability {
  switch (providerId) {
    case "anthropic":
      return { status: "supported", provider: "claude" };
    case "openai-codex":
      return { status: "supported", provider: "codex" };
    case "meta":
      return { status: "supported", provider: "muse" };
    case "opencode-go":
      return { status: "supported", provider: "opencode" };
    case "github-copilot":
      return { status: "supported", provider: "copilot" };
    case "openai":
      return OPENAI_USAGE_UNSUPPORTED;
    case undefined:
      return { status: "no-model" };
    default:
      // A missing integration says nothing about the provider's API capabilities.
      return {
        status: "unimplemented",
        message: "Usage fetching is not implemented for this provider.",
      };
  }
}
