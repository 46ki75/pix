import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export type ThemeBg = Parameters<Theme["bg"]>[0];
type TokenInfo = readonly [group: string, description: string];

// Records, rather than arrays, make additions to Pi's token unions fail type checking.
// Descriptions summarize Pi 0.87.1's theme schema (linked in CONTRIBUTING.md).
const foreground = {
  accent: ["General", "Primary UI accent"],
  text: ["General", "Default text"],
  muted: ["General", "Secondary text"],
  dim: ["General", "Very subtle text"],
  border: ["Borders", "Normal borders"],
  borderAccent: ["Borders", "Highlighted borders"],
  borderMuted: ["Borders", "Subtle borders"],
  success: ["Status", "Success indicators"],
  error: ["Status", "Error indicators"],
  warning: ["Status", "Warning indicators"],
  scrollbarTrack: ["Scrollbars/search", "Fullscreen scrollbar track"],
  scrollbarThumb: ["Scrollbars/search", "Fullscreen scrollbar thumb"],
  searchMatchText: [
    "Scrollbars/search",
    "Search match text; current-match background",
  ],
  thinkingText: ["Messages", "Thinking block text"],
  userMessageText: ["Messages", "User message text"],
  customMessageText: ["Messages", "Custom message text"],
  customMessageLabel: ["Messages", "Custom message type label"],
  toolTitle: ["Tools", "Tool execution title"],
  toolOutput: ["Tools", "Tool output text"],
  mdHeading: ["Markdown", "Markdown headings"],
  mdLink: ["Markdown", "Markdown link text"],
  mdLinkUrl: ["Markdown", "Markdown link URLs"],
  mdCode: ["Markdown", "Inline code"],
  mdCodeBlock: ["Markdown", "Code block content"],
  mdCodeBlockBorder: ["Markdown", "Code block fences"],
  mdQuote: ["Markdown", "Blockquote text"],
  mdQuoteBorder: ["Markdown", "Blockquote borders"],
  mdHr: ["Markdown", "Horizontal rules"],
  mdListBullet: ["Markdown", "List bullets and numbers"],
  toolDiffAdded: ["Diffs", "Added diff lines"],
  toolDiffRemoved: ["Diffs", "Removed diff lines"],
  toolDiffContext: ["Diffs", "Unchanged diff context"],
  syntaxComment: ["Syntax", "Code comments"],
  syntaxKeyword: ["Syntax", "Code keywords"],
  syntaxFunction: ["Syntax", "Function names in code"],
  syntaxVariable: ["Syntax", "Variable names in code"],
  syntaxString: ["Syntax", "String literals"],
  syntaxNumber: ["Syntax", "Number literals"],
  syntaxType: ["Syntax", "Type names in code"],
  syntaxOperator: ["Syntax", "Code operators"],
  syntaxPunctuation: ["Syntax", "Code punctuation"],
  thinkingOff: ["Thinking-level borders", "Editor border: thinking off"],
  thinkingMinimal: [
    "Thinking-level borders",
    "Editor border: minimal thinking",
  ],
  thinkingLow: ["Thinking-level borders", "Editor border: low thinking"],
  thinkingMedium: ["Thinking-level borders", "Editor border: medium thinking"],
  thinkingHigh: ["Thinking-level borders", "Editor border: high thinking"],
  thinkingXhigh: ["Thinking-level borders", "Editor border: xhigh thinking"],
  thinkingMax: ["Thinking-level borders", "Editor border: max thinking"],
  bashMode: ["Bash-mode border", "Editor border in bash mode"],
} satisfies Record<ThemeColor, TokenInfo>;

const background = {
  selectedBg: ["Selection/search", "Selected item background"],
  searchMatchBg: [
    "Selection/search",
    "Search match background; current-match text",
  ],
  userMessageBg: ["Messages", "User message background"],
  customMessageBg: ["Messages", "Custom message background"],
  toolPendingBg: ["Tool states", "Pending tool background"],
  toolSuccessBg: ["Tool states", "Successful tool background"],
  toolErrorBg: ["Tool states", "Failed tool background"],
} satisfies Record<ThemeBg, TokenInfo>;

export type ColorToken = {
  group: string;
  description: string;
} & (
  | { kind: "foreground"; name: ThemeColor }
  | { kind: "background"; name: ThemeBg }
);

export const TOKENS: readonly ColorToken[] = [
  ...Object.entries(foreground).map(([name, [group, description]]) => ({
    kind: "foreground" as const,
    name: name as ThemeColor,
    group,
    description,
  })),
  ...Object.entries(background).map(([name, [group, description]]) => ({
    kind: "background" as const,
    name: name as ThemeBg,
    group,
    description,
  })),
];
