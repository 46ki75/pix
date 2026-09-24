import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { ANSI } from "./ansi.ts";
import {
  collectUsage,
  createFooter,
  formatContextBar,
  formatTokens,
} from "./footer.ts";

function assistant(input = 100, cacheRead = 900, cacheWrite = 0) {
  return {
    role: "assistant" as const,
    content: [],
    api: "openai-responses" as const,
    provider: "openai-codex",
    model: "test-model",
    stopReason: "stop" as const,
    timestamp: 0,
    usage: {
      input,
      output: 50,
      cacheRead,
      cacheWrite,
      totalTokens: input + cacheRead + cacheWrite + 50,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.03,
      },
    },
  };
}

function fixture() {
  const sessionManager = SessionManager.inMemory("/workspace");
  const ctx = {
    cwd: "/workspace",
    sessionManager,
    model: {
      id: "test-model",
      provider: "openai-codex",
      contextWindow: 272_000,
      reasoning: true,
    },
    thinkingLevel: "high",
    getContextUsage: vi.fn<ExtensionContext["getContextUsage"]>(() => ({
      tokens: 98_192,
      contextWindow: 272_000,
      percent: 36.1,
    })),
  } as unknown as ExtensionContext;
  const unsubscribe = vi.fn();
  const footerData = {
    getGitBranch: vi.fn<ReadonlyFooterDataProvider["getGitBranch"]>(
      () => "main",
    ),
    getExtensionStatuses: vi.fn(() => new Map<string, string>()),
    getAvailableProviderCount: () => 1,
    onBranchChange: vi.fn((_callback: () => void) => unsubscribe),
  } satisfies ReadonlyFooterDataProvider;
  const tui = { requestRender: vi.fn() };
  const theme = { fg: (_color: string, text: string) => text };
  return { ctx, sessionManager, footerData, tui, theme, unsubscribe };
}

test.each([
  [0, "0"],
  [999, "999"],
  [1_000, "1.0k"],
  [12_000, "12k"],
  [118_000, "118k"],
  [2_300_000, "2.3M"],
  [12_000_000, "12M"],
])("formats %i tokens as %s", (count, expected) => {
  expect(formatTokens(count)).toBe(expected);
});

test.each([
  [-1, "░░░░", "brightGreen"],
  [0, "░░░░", "brightGreen"],
  [0.1, "▓░░░", "brightGreen"],
  [24.9, "▓░░░", "brightGreen"],
  [25, "█░░░", "brightGreen"],
  [25.1, "█▓░░", "brightGreen"],
  [49.9, "█▓░░", "brightGreen"],
  [50, "██░░", "brightGreen"],
  [50.1, "██▓░", "yellow"],
  [74.9, "██▓░", "yellow"],
  [75, "███░", "yellow"],
  [75.1, "███▓", "red"],
  [99.9, "███▓", "red"],
  [100, "████", "red"],
  [150, "████", "red"],
] as const)("renders the context bar at %s%%", (percent, bar, color) => {
  const result = formatContextBar(percent);
  expect(result).toBe(`${ANSI.fg[color]}${bar}${ANSI.reset.fg}`);
  expect(visibleWidth(result)).toBe(4);
});

test.each([null, undefined, Number.NaN, Infinity, -Infinity])(
  "omits the context bar for unknown usage %s",
  (percent) => {
    expect(formatContextBar(percent)).toBe("");
  },
);

test.each([
  [homedir(), "~"],
  [
    join(homedir(), "org/46ki75/pix/packages/statusline"),
    join("~", "org/46ki75/pix/packages/statusline"),
  ],
  [join(homedir(), "..notes"), join("~", "..notes")],
  [
    join(`${homedir()}-other`, "project"),
    join(`${homedir()}-other`, "project"),
  ],
])("displays the working directory %s as %s", (cwd, expected) => {
  const { ctx, tui, theme, footerData } = fixture();
  ctx.cwd = cwd;
  const footer = createFooter(ctx, tui, theme, footerData);
  expect(stripVTControlCharacters(footer.render(1_000)[1] ?? "")).toBe(
    `  ${expected}   main `,
  );
  footer.dispose();
});

test.each([" pix", " pix/packages/statusline"])(
  "renders the resolved repository location %s",
  (directory) => {
    const { ctx, tui, theme, footerData } = fixture();
    const footer = createFooter(ctx, tui, theme, footerData, directory);
    expect(stripVTControlCharacters(footer.render(120)[1] ?? "")).toBe(
      ` ${directory}   main `,
    );
    footer.dispose();
  },
);

test.each([
  ["main", undefined, "  pix   main "],
  ["main", "Planning", "  pix   main • Planning "],
  [null, undefined, "  pix "],
  [null, "Planning", "  pix  Planning "],
  ["detached", undefined, "  pix   detached "],
] as const)(
  "joins directory, branch %s, and session name %s",
  (branch, name, expected) => {
    const { ctx, sessionManager, tui, theme, footerData } = fixture();
    footerData.getGitBranch.mockReturnValue(branch);
    vi.spyOn(sessionManager, "getSessionName").mockReturnValue(name);
    const footer = createFooter(ctx, tui, theme, footerData, " pix");
    expect(stripVTControlCharacters(footer.render(120)[1] ?? "")).toBe(
      expected,
    );
    footer.dispose();
  },
);

test("refreshes the connected branch segment without reinstalling the footer", () => {
  const { ctx, tui, theme, footerData } = fixture();
  const footer = createFooter(ctx, tui, theme, footerData, " pix");
  expect(stripVTControlCharacters(footer.render(120)[1] ?? "")).toBe(
    "  pix   main ",
  );
  footerData.getGitBranch.mockReturnValue("feature");
  expect(stripVTControlCharacters(footer.render(120)[1] ?? "")).toBe(
    "  pix   feature ",
  );
  footerData.getGitBranch.mockReturnValue(null);
  expect(stripVTControlCharacters(footer.render(120)[1] ?? "")).toBe(
    "  pix ",
  );
  footer.dispose();
});

test("accounts for assistants, tool calls, summaries, and standalone usage", () => {
  const message = assistant();
  const base = {
    id: "entry",
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
  };
  const entries: SessionEntry[] = [
    { ...base, type: "message", message },
    {
      ...base,
      type: "message",
      message: { role: "user", content: "Hi", timestamp: 0 },
    },
    {
      ...base,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "test",
        content: [],
        isError: false,
        timestamp: 0,
        usage: message.usage,
      },
    },
    {
      ...base,
      type: "usage",
      kind: "cache_warm",
      provider: "test",
      model: "test",
      usage: message.usage,
    },
    {
      ...base,
      type: "compaction",
      summary: "Summary",
      firstKeptEntryId: "entry",
      tokensBefore: 1_000,
      usage: message.usage,
    },
    {
      ...base,
      type: "branch_summary",
      fromId: "entry",
      summary: "Summary",
      usage: message.usage,
    },
    { ...base, type: "branch_summary", fromId: "entry", summary: "No usage" },
  ];
  expect(collectUsage(entries)).toEqual({
    input: 500,
    output: 250,
    cacheRead: 4_500,
    cacheWrite: 0,
    cost: 0.15,
    cacheHitRate: 90,
  });
  entries.push({ ...base, type: "message", message: assistant(0, 0) });
  expect(collectUsage(entries).cacheHitRate).toBeUndefined();
});

test.each([0, 1, 40])(
  "right-aligns compact metrics beside the model with %i extra columns",
  (extra) => {
    const { ctx, tui, theme, footerData } = fixture();
    const footer = createFooter(ctx, tui, theme, footerData);
    const model = "󱘖 openai-codex  test-model (272k) 󱩔 high";
    const metrics = " ? 󰓅 36.1% █▓░░";
    const width = visibleWidth(model) + 2 + visibleWidth(metrics) + extra;
    const lines = footer.render(width);
    expect(lines).toHaveLength(2);
    expect(stripVTControlCharacters(lines[0] ?? "")).toBe(
      model + " ".repeat(2 + extra) + metrics,
    );
    expect(visibleWidth(lines[0] ?? "")).toBe(width);
    footer.dispose();
  },
);

test.each([
  ["openai-codex", "test-model", true],
  ["openai-codex", "test-model", false],
  ["提供元🚀", "モデル🚀", true],
] as const)(
  "hides provider %s then cache-hit rate before truncating model %s (reasoning: %s)",
  (provider, id, reasoning) => {
    const { ctx, sessionManager, tui, footerData } = fixture();
    if (!ctx.model) throw new Error("Missing fixture model");
    Object.assign(ctx.model, { provider, id, reasoning });
    sessionManager.appendMessage(assistant());
    const theme = {
      fg: (_color: string, text: string) =>
        `${ANSI.fg.brightBlack}${text}${ANSI.reset.fg}`,
    };
    const footer = createFooter(ctx, tui, theme, footerData);
    const model = ` ${id} (272k)${reasoning ? " 󱩔 high" : ""}`;
    const fullModel = `󱘖 ${provider} ${model}`;
    const contextMetrics = "󰓅 36.1% █▓░░";
    const metrics = ` 90.0% ${contextMetrics}`;
    const fullWidth = visibleWidth(fullModel) + 2 + visibleWidth(metrics);
    const compactWidth = visibleWidth(model) + 2 + visibleWidth(metrics);
    const minimumWidth = visibleWidth(model) + 2 + visibleWidth(contextMetrics);

    expect(stripVTControlCharacters(footer.render(fullWidth)[0] ?? "")).toBe(
      `${fullModel}  ${metrics}`,
    );
    for (let width = fullWidth - 1; width >= compactWidth; width--) {
      const line = footer.render(width)[0] ?? "";
      expect(stripVTControlCharacters(line)).toBe(
        model + " ".repeat(width - compactWidth + 2) + metrics,
      );
      expect(line).toContain(`${ANSI.fg.brightBlack}${model}${ANSI.reset.fg}`);
      expect(visibleWidth(line)).toBe(width);
    }
    for (let width = compactWidth - 1; width >= minimumWidth; width--) {
      const line = footer.render(width)[0] ?? "";
      expect(stripVTControlCharacters(line)).toBe(
        model + " ".repeat(width - minimumWidth + 2) + contextMetrics,
      );
      expect(line).toContain(
        `${ANSI.fg.brightGreen}󰓅 36.1%${ANSI.reset.fg} ${ANSI.fg.brightGreen}█▓░░${ANSI.reset.fg}`,
      );
      expect(visibleWidth(line)).toBe(width);
    }
    for (const width of [1, 2, 3, 10, minimumWidth - 1]) {
      const line = footer.render(width)[0] ?? "";
      expect(line).not.toContain("󱘖");
      expect(line).not.toContain(provider);
      expect(line).not.toContain("");
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(stripVTControlCharacters(footer.render(compactWidth)[0] ?? "")).toBe(
      `${model}  ${metrics}`,
    );
    expect(stripVTControlCharacters(footer.render(fullWidth)[0] ?? "")).toBe(
      `${fullModel}  ${metrics}`,
    );
    footer.dispose();
  },
);

test.each([true, false])(
  "hides unknown cache-hit rate before unknown context usage (has model: %s)",
  (hasModel) => {
    const { ctx, tui, theme, footerData } = fixture();
    if (!hasModel) ctx.model = undefined;
    ctx.getContextUsage = () => undefined;
    const footer = createFooter(ctx, tui, theme, footerData);
    const model = hasModel ? " test-model (272k) 󱩔 high" : "no-model (?)";
    const width = visibleWidth(model) + 2 + visibleWidth("󰓅 ?");
    expect(stripVTControlCharacters(footer.render(width)[0] ?? "")).toBe(
      `${model}  󰓅 ?`,
    );
    const restoredWidth = width + visibleWidth(" ? ");
    expect(
      stripVTControlCharacters(footer.render(restoredWidth)[0] ?? ""),
    ).toBe(`${model}   ? 󰓅 ?`);
    footer.dispose();
  },
);

test.each([
  [undefined, "?"],
  [assistant(0, 0), "?"],
  [assistant(100, 0), "0.0%"],
  [assistant(0, 900), "100.0%"],
  [assistant(100, 900, 200), "75.0%"],
] as const)(
  "matches the model's dim color for cache-hit rate case %# without token counters",
  (message, expected) => {
    const { ctx, sessionManager, tui, footerData } = fixture();
    if (message) sessionManager.appendMessage(message);
    const theme = {
      fg: (color: string, text: string) =>
        `${color === "dim" ? ANSI.fg.brightBlack : ANSI.fg.white}${text}${ANSI.reset.fg}`,
    };
    const footer = createFooter(ctx, tui, theme, footerData);
    const lines = footer.render(120);
    expect(lines[0]).toContain(
      `${ANSI.fg.brightBlack}󱘖 openai-codex  test-model (272k) 󱩔 high${ANSI.reset.fg}`,
    );
    expect(lines[0]).toContain(
      `${ANSI.fg.brightBlack} ${expected}${ANSI.reset.fg} ${ANSI.fg.brightGreen}󰓅 36.1%${ANSI.reset.fg}`,
    );
    expect(stripVTControlCharacters(lines[0] ?? "")).not.toMatch(
      /[↑↓$]|[RW]\d/,
    );
    footer.dispose();
  },
);

test.each([
  [0, "░░░░", "brightGreen"],
  [0.8, "▓░░░", "brightGreen"],
  [60, "██▓░", "yellow"],
  [80, "███▓", "red"],
] as const)(
  "renders bright green context icon and percentage at %s percent with %s in %s",
  (percent, bar, color) => {
    const { ctx, tui, theme, footerData } = fixture();
    ctx.getContextUsage = () => ({
      tokens: (272_000 * percent) / 100,
      percent,
      contextWindow: 272_000,
    });
    const footer = createFooter(ctx, tui, theme, footerData);
    const stats = footer.render(120)[0] ?? "";
    expect(stats).toContain(
      `${ANSI.fg.brightGreen}󰓅 ${percent.toFixed(1)}%${ANSI.reset.fg} ${ANSI.fg[color]}${bar}${ANSI.reset.fg}`,
    );
    expect(visibleWidth(stats)).toBe(120);
    footer.dispose();
  },
);

test("renders live usage, context, model, branch, and extension statuses", () => {
  const { ctx, sessionManager, footerData, tui, theme } = fixture();
  sessionManager.appendMessage(assistant());
  footerData.getExtensionStatuses.mockReturnValue(
    new Map([
      ["z", "Second\nline"],
      ["a", "First"],
    ]),
  );
  const footer = createFooter(ctx, tui, theme, footerData);
  const lines = footer.render(120);
  expect(lines).toHaveLength(3);
  expect(stripVTControlCharacters(lines[0] ?? "")).toMatch(
    /^󱘖 openai-codex  test-model \(272k\) 󱩔 high {2,} 90.0% 󰓅 36.1% █▓░░$/,
  );
  expect(lines[0]).toContain(`${ANSI.fg.brightGreen}█▓░░${ANSI.reset.fg}`);
  expect(visibleWidth(lines[0] ?? "")).toBe(120);
  expect(stripVTControlCharacters(lines[1] ?? "")).toBe(
    "  /workspace   main ",
  );
  expect(lines[2]).toBe("First Second line");

  sessionManager.appendMessage(assistant(200, 800));
  ctx.thinkingLevel = "off";
  ctx.getContextUsage = () => ({
    tokens: 102_400,
    percent: 80,
    contextWindow: 128_000,
  });
  expect(footer.render(120)[0]).toContain(
    `${ANSI.fg.brightGreen}󰓅 80.0%${ANSI.reset.fg} ${ANSI.fg.red}███▓${ANSI.reset.fg}`,
  );
  expect(footer.render(120)[0]).toContain(" test-model (128k) 󰹐 off");
  ctx.getContextUsage = () => ({
    tokens: null,
    percent: null,
    contextWindow: 272_000,
  });
  expect(stripVTControlCharacters(footer.render(120)[0] ?? "")).toContain(
    " 80.0% 󰓅 ?",
  );
  expect(footer.render(120)[0]).toContain(" test-model (272k) 󰹐 off");
  expect(footer.render(120)[0]).not.toMatch(/[█▓░$]/);
  ctx.model = undefined;
  ctx.getContextUsage = () => undefined;
  expect(stripVTControlCharacters(footer.render(120)[0] ?? "")).toMatch(
    /^no-model \(\?\) {2,} 80.0% 󰓅 \?$/,
  );
  expect(footer.render(120)[0]).not.toMatch(/[█▓░]/);
  expect(footer.render(120)[0]).toContain(
    `${ANSI.fg.brightGreen}󰓅 ?${ANSI.reset.fg}`,
  );
  footer.dispose();
});

test.each([
  [128_000, 272_000, "128k"],
  [undefined, 272_000, "272k"],
  [undefined, 0, "?"],
] as const)(
  "shows context window %s (model limit %s) beside the model as %s",
  (reported, configured, expected) => {
    const { ctx, tui, theme, footerData } = fixture();
    if (!ctx.model) throw new Error("Missing fixture model");
    ctx.model.contextWindow = configured;
    ctx.getContextUsage = () =>
      reported === undefined
        ? undefined
        : {
            tokens: null,
            percent: null,
            contextWindow: reported,
          };
    const footer = createFooter(ctx, tui, theme, footerData);
    const stats = stripVTControlCharacters(footer.render(120)[0] ?? "");
    expect(stats).toContain(`󱘖 openai-codex  test-model (${expected}) 󱩔 high`);
    expect(stats).toMatch(/ {2,} \? 󰓅 \?$/);
    expect(stats).not.toContain("$");
    footer.dispose();
  },
);

test.each([
  ["off", "󰹐 off"],
  ["minimal", "󱩎 minimal"],
  ["low", "󱩐 low"],
  ["medium", "󱩒 medium"],
  ["high", "󱩔 high"],
  ["xhigh", "󱩖 xhigh"],
  ["max", "󰛨 max"],
  [undefined, "󰹐 off"],
] as const)(
  "renders the thinking effort %s with its icon",
  (thinking, label) => {
    const { ctx, tui, theme, footerData } = fixture();
    if (thinking === undefined) delete ctx.thinkingLevel;
    else ctx.thinkingLevel = thinking;
    const footer = createFooter(ctx, tui, theme, footerData);
    expect(stripVTControlCharacters(footer.render(120)[0] ?? "")).toContain(
      `󱘖 openai-codex  test-model (272k) ${label}`,
    );
    footer.dispose();
  },
);

test("omits thinking effort for non-reasoning and missing models", () => {
  const { ctx, tui, theme, footerData } = fixture();
  if (!ctx.model) throw new Error("Missing fixture model");
  ctx.model.reasoning = false;
  const footer = createFooter(ctx, tui, theme, footerData);
  expect(stripVTControlCharacters(footer.render(120)[0] ?? "")).toMatch(
    /^󱘖 openai-codex  test-model \(272k\) {2,} \? 󰓅 36.1% █▓░░$/,
  );
  ctx.model = undefined;
  expect(stripVTControlCharacters(footer.render(120)[0] ?? "")).toMatch(
    /^no-model \(272k\) {2,} \? 󰓅 36.1% █▓░░$/,
  );
  footer.dispose();
});

test("fits ANSI and wide text at narrow widths and reads theme changes", () => {
  const { ctx, footerData, tui } = fixture();
  ctx.cwd = "/作業/🚀";
  footerData.getExtensionStatuses.mockReturnValue(
    new Map([["a", "\u001b[32mReady 界🚀\u001b[0m"]]),
  );
  let color = "2";
  const theme = {
    fg: (_color: string, text: string) => `\u001b[${color}m${text}\u001b[0m`,
  };
  const footer = createFooter(ctx, tui, theme, footerData);
  expect(footer.render(0)).toEqual([]);
  for (const width of [1, 2, 3, 10, 40, 80, 120]) {
    for (const line of footer.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line).not.toMatch(/[\r\n\t]/);
    }
  }
  color = "36";
  footer.invalidate();
  expect(footer.render(80)[0]).toContain(
    `${ANSI.fg.brightGreen}󰓅 36.1%${ANSI.reset.fg} ${ANSI.fg.brightGreen}█▓░░${ANSI.reset.fg}`,
  );
  expect(footer.render(80)[0]).toContain(
    `\u001b[36m ?\u001b[0m ${ANSI.fg.brightGreen}󰓅 36.1%${ANSI.reset.fg}`,
  );
  expect(footer.render(80)[0]).toContain(
    "\u001b[36m󱘖 openai-codex  test-model (272k) 󱩔 high\u001b[0m",
  );
  footer.dispose();
});

test("requests rendering on branch changes and releases the subscription", () => {
  const { ctx, tui, theme, footerData, unsubscribe } = fixture();
  const footer = createFooter(ctx, tui, theme, footerData);
  footerData.onBranchChange.mock.calls[0]?.[0]();
  expect(tui.requestRender).toHaveBeenCalledOnce();
  footer.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
