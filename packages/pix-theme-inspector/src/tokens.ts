import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export type ThemeBg = Parameters<Theme["bg"]>[0];

// Records, rather than arrays, make additions to Pi's token unions fail type checking.
const foreground = {
  accent: "General",
  text: "General",
  muted: "General",
  dim: "General",
  border: "Borders",
  borderAccent: "Borders",
  borderMuted: "Borders",
  success: "Status",
  error: "Status",
  warning: "Status",
  scrollbarTrack: "Scrollbars/search",
  scrollbarThumb: "Scrollbars/search",
  searchMatchText: "Scrollbars/search",
  thinkingText: "Messages",
  userMessageText: "Messages",
  customMessageText: "Messages",
  customMessageLabel: "Messages",
  toolTitle: "Tools",
  toolOutput: "Tools",
  mdHeading: "Markdown",
  mdLink: "Markdown",
  mdLinkUrl: "Markdown",
  mdCode: "Markdown",
  mdCodeBlock: "Markdown",
  mdCodeBlockBorder: "Markdown",
  mdQuote: "Markdown",
  mdQuoteBorder: "Markdown",
  mdHr: "Markdown",
  mdListBullet: "Markdown",
  toolDiffAdded: "Diffs",
  toolDiffRemoved: "Diffs",
  toolDiffContext: "Diffs",
  syntaxComment: "Syntax",
  syntaxKeyword: "Syntax",
  syntaxFunction: "Syntax",
  syntaxVariable: "Syntax",
  syntaxString: "Syntax",
  syntaxNumber: "Syntax",
  syntaxType: "Syntax",
  syntaxOperator: "Syntax",
  syntaxPunctuation: "Syntax",
  thinkingOff: "Thinking-level borders",
  thinkingMinimal: "Thinking-level borders",
  thinkingLow: "Thinking-level borders",
  thinkingMedium: "Thinking-level borders",
  thinkingHigh: "Thinking-level borders",
  thinkingXhigh: "Thinking-level borders",
  thinkingMax: "Thinking-level borders",
  bashMode: "Bash-mode border",
} satisfies Record<ThemeColor, string>;

const background = {
  selectedBg: "Selection/search",
  searchMatchBg: "Selection/search",
  userMessageBg: "Messages",
  customMessageBg: "Messages",
  toolPendingBg: "Tool states",
  toolSuccessBg: "Tool states",
  toolErrorBg: "Tool states",
} satisfies Record<ThemeBg, string>;

export type ColorToken =
  | { kind: "foreground"; name: ThemeColor; group: string }
  | { kind: "background"; name: ThemeBg; group: string };

export const TOKENS: readonly ColorToken[] = [
  ...Object.entries(foreground).map(([name, group]) => ({
    kind: "foreground" as const,
    name: name as ThemeColor,
    group,
  })),
  ...Object.entries(background).map(([name, group]) => ({
    kind: "background" as const,
    name: name as ThemeBg,
    group,
  })),
];
