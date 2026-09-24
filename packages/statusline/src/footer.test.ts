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
  const theme = {
    fg: (color: string, text: string) =>
      color === "text" ? `${ANSI.fg.white}${text}${ANSI.reset.fg}` : text,
  };
  return { ctx, sessionManager, footerData, tui, theme, unsubscribe };
}

function expectFullWidthLocation(
  line: string | undefined,
  expected: string,
  width: number,
) {
  const text = stripVTControlCharacters(line ?? "");
  expect(text.replace(/ +$/, " ")).toBe(expected);
  expect(visibleWidth(text)).toBe(width);
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
  expectFullWidthLocation(
    footer.render(1_000)[2],
    `  ${expected}   main  `,
    1_000,
  );
  footer.dispose();
});

test.each([" pix", " pix/packages/statusline"])(
  "renders the resolved repository location %s",
  (directory) => {
    const { ctx, tui, theme, footerData } = fixture();
    const footer = createFooter(ctx, tui, theme, footerData, directory);
    const line = footer.render(120)[2] ?? "";
    expectFullWidthLocation(line, ` ${directory}   main  `, 120);
    expect(line.startsWith(`${ANSI.reset.bg}\x1b[38;2;189;166;139m`)).toBe(
      true,
    );
    expect(line).toContain(
      `\x1b[48;2;189;166;139m\x1b[38;2;64;68;76m ${directory} \x1b[38;2;189;166;139m\x1b[48;2;198;181;162m\x1b[48;2;198;181;162m\x1b[38;2;57;62;70m  main `,
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
  ["作業/🚀", "cafe\u0301", "  pix   作業/🚀 • cafe\u0301 "],
] as const)(
  "fills the row with directory, branch %s, and session name %s",
  (branch, name, expected) => {
    const { ctx, sessionManager, tui, theme, footerData } = fixture();
    footerData.getGitBranch.mockReturnValue(branch);
    vi.spyOn(sessionManager, "getSessionName").mockReturnValue(name);
    const footer = createFooter(ctx, tui, theme, footerData, " pix");
    const naturalWidth = visibleWidth(expected);
    expectFullWidthLocation(
      footer.render(naturalWidth)[2],
      expected,
      naturalWidth,
    );
    for (const width of [40, 120, 80]) {
      expectFullWidthLocation(
        footer.render(width)[2],
        `${expected.slice(0, -1)} `,
        width,
      );
    }
    expectFullWidthLocation(
      footer.render(naturalWidth)[2],
      expected,
      naturalWidth,
    );
    footer.dispose();
  },
);

test.each([
  ["main", "Planning"],
  [null, "Planning"],
  [null, undefined],
] as const)(
  "keeps fixed location colors across theme changes (branch: %s, name: %s)",
  (branch, name) => {
    const { ctx, sessionManager, tui, theme, footerData } = fixture();
    footerData.getGitBranch.mockReturnValue(branch);
    vi.spyOn(sessionManager, "getSessionName").mockReturnValue(name);
    const fg = vi.spyOn(theme, "fg");
    const footer = createFooter(ctx, tui, theme, footerData, " pix");
    const details = [branch ? ` ${branch}` : undefined, name]
      .filter(Boolean)
      .join(" • ");
    for (const color of ["\x1b[38;2;212;212;212m", "\x1b[38;2;31;35;40m"]) {
      fg.mockImplementation((role, text) =>
        role === "text" ? `${color}${text}${ANSI.reset.fg}` : text,
      );
      footer.invalidate();
      const line = footer.render(120)[2] ?? "";
      expect(fg).not.toHaveBeenCalledWith("text", expect.any(String));
      expect(line).toContain(
        "\x1b[48;2;189;166;139m\x1b[38;2;64;68;76m  pix ",
      );
      if (details) {
        expect(line).toContain(
          `\x1b[48;2;198;181;162m\x1b[38;2;57;62;70m ${details} `,
        );
      }
      expect(line).toContain("\x1b[48;2;202;191;178m\x1b[38;2;49;53;58m");
      expect(
        line.endsWith(
          `${ANSI.reset.bg}\x1b[38;2;202;191;178m${ANSI.reset.fg}`,
        ),
      ).toBe(true);
      expect(visibleWidth(line)).toBe(120);
    }
    footer.dispose();
  },
);

test.each(["main", null])(
  "adds #cabfb2 filler without shortening labels (branch: %s)",
  (branch) => {
    const { ctx, tui, theme, footerData } = fixture();
    footerData.getGitBranch.mockReturnValue(branch);
    const footer = createFooter(ctx, tui, theme, footerData, " pix");
    const natural = branch ? "  pix   main " : "  pix ";
    const capColor = branch
      ? "\x1b[38;2;198;181;162m"
      : "\x1b[38;2;189;166;139m";
    for (const extra of [0, 1, 2, 3, 20, 2, 3]) {
      const width = visibleWidth(natural) + extra;
      const line = footer.render(width)[2] ?? "";
      expect(visibleWidth(line)).toBe(width);
      if (extra >= 3) {
        const padding = " ".repeat(extra - 1);
        expect(stripVTControlCharacters(line)).toBe(
          `${natural.slice(0, -1)}${padding}`,
        );
        expect(line).toContain(
          `${capColor}\x1b[48;2;202;191;178m\x1b[48;2;202;191;178m\x1b[38;2;49;53;58m${padding}${ANSI.reset.bg}\x1b[38;2;202;191;178m${ANSI.reset.fg}`,
        );
      } else {
        expect(stripVTControlCharacters(line)).toBe(
          `${natural.slice(0, -1)}${" ".repeat(extra)}`,
        );
        expect(line).not.toContain("\x1b[48;2;202;191;178m");
      }
    }
    footer.dispose();
  },
);

test("keeps the rounded right cap when truncating a long branch", () => {
  const { ctx, tui, theme, footerData } = fixture();
  footerData.getGitBranch.mockReturnValue("fix/statusline-full-width-location");
  const footer = createFooter(
    ctx,
    tui,
    theme,
    footerData,
    " pix/packages/statusline",
  );
  const expected =
    "  pix/packages/statusline   fix/statusline-full-width-loca... ";
  const width = visibleWidth(expected);
  const line = footer.render(width)[2] ?? "";
  expect(stripVTControlCharacters(line)).toBe(expected);
  expect(visibleWidth(line)).toBe(width);
  expect(line).toContain(
    `\x1b[48;2;198;181;162m\x1b[38;2;57;62;70m  fix/statusline-full-width-loca... ${ANSI.reset.bg}\x1b[38;2;198;181;162m${ANSI.reset.fg}`,
  );
  footer.dispose();
});

test("refreshes the connected branch segment without reinstalling the footer", () => {
  const { ctx, tui, theme, footerData } = fixture();
  const footer = createFooter(ctx, tui, theme, footerData, " pix");
  expectFullWidthLocation(footer.render(120)[2], "  pix   main  ", 120);
  footerData.getGitBranch.mockReturnValue("feature");
  expectFullWidthLocation(
    footer.render(120)[2],
    "  pix   feature  ",
    120,
  );
  footerData.getGitBranch.mockReturnValue(null);
  expectFullWidthLocation(footer.render(120)[2], "  pix  ", 120);
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

test.each([1, 40, 120])(
  "separates model metrics and location with a blank row at width %i",
  (width) => {
    const { ctx, tui, theme, footerData } = fixture();
    const footer = createFooter(ctx, tui, theme, footerData);
    const lines = footer.render(width);
    expect(lines[1]).toBe("");
    expect(lines).toHaveLength(3);
    expect(lines[0]).not.toBe("");
    expect(lines[2]).not.toBe("");
    footer.dispose();
  },
);

test.each([0, 1, 40])(
  "right-aligns compact metrics beside the model with %i extra columns",
  (extra) => {
    const { ctx, tui, theme, footerData } = fixture();
    const footer = createFooter(ctx, tui, theme, footerData);
    const model = "󱘖 openai-codex  test-model · 272k 󱩔 high";
    const metrics = " ? 󰓅 36.1% █▓░░";
    const width = visibleWidth(` ${model}  ${metrics} `) + extra;
    const lines = footer.render(width);
    expect(lines).toHaveLength(3);
    expect(stripVTControlCharacters(lines[0] ?? "")).toBe(
      ` ${model}${" ".repeat(2 + extra)}${metrics} `,
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
      fg: (color: string, text: string) =>
        `${color === "muted" ? ANSI.fg.white : ANSI.fg.brightBlack}${text}${ANSI.reset.fg}`,
    };
    const footer = createFooter(ctx, tui, theme, footerData);
    const model = ` ${id} · 272k${reasoning ? " 󱩔 high" : ""}`;
    const fullModel = `󱘖 ${provider} ${model}`;
    const contextMetrics = "󰓅 36.1% █▓░░";
    const metrics = ` 90.0% ${contextMetrics}`;
    const fullWidth = visibleWidth(` ${fullModel}  ${metrics} `);
    const compactWidth = visibleWidth(` ${model}  ${metrics} `);
    const minimumWidth = visibleWidth(` ${model}  ${contextMetrics} `);

    expect(stripVTControlCharacters(footer.render(fullWidth)[0] ?? "")).toBe(
      ` ${fullModel}  ${metrics} `,
    );
    for (let width = fullWidth - 1; width >= compactWidth; width--) {
      const line = footer.render(width)[0] ?? "";
      expect(stripVTControlCharacters(line)).toBe(
        ` ${model}${" ".repeat(width - compactWidth + 2)}${metrics} `,
      );
      expect(line).toContain(
        `${ANSI.fg.white}${ANSI.reset.fg} ${ANSI.fg.brightBlack}${id} · 272k${ANSI.reset.fg}`,
      );
      expect(visibleWidth(line)).toBe(width);
    }
    for (let width = compactWidth - 1; width >= minimumWidth; width--) {
      const line = footer.render(width)[0] ?? "";
      expect(stripVTControlCharacters(line)).toBe(
        ` ${model}${" ".repeat(width - minimumWidth + 2)}${contextMetrics} `,
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
      ` ${model}  ${metrics} `,
    );
    expect(stripVTControlCharacters(footer.render(fullWidth)[0] ?? "")).toBe(
      ` ${fullModel}  ${metrics} `,
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
    const model = hasModel ? " test-model · 272k 󱩔 high" : "no-model · ?";
    const width = visibleWidth(` ${model}  󰓅 ? `);
    expect(stripVTControlCharacters(footer.render(width)[0] ?? "")).toBe(
      ` ${model}  󰓅 ? `,
    );
    const restoredWidth = width + visibleWidth(" ? ");
    expect(
      stripVTControlCharacters(footer.render(restoredWidth)[0] ?? ""),
    ).toBe(` ${model}   ? 󰓅 ? `);
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
  "uses lighter icons and dim labels for cache-hit rate case %# without token counters",
  (message, expected) => {
    const { ctx, sessionManager, tui, footerData } = fixture();
    if (message) sessionManager.appendMessage(message);
    const theme = {
      fg: vi.fn(
        (color: string, text: string) =>
          `${color === "muted" ? ANSI.fg.white : ANSI.fg.brightBlack}${text}${ANSI.reset.fg}`,
      ),
    };
    const footer = createFooter(ctx, tui, theme, footerData);
    const lines = footer.render(120);
    for (const [icon, label] of [
      ["󱘖", "openai-codex"],
      ["", "test-model · 272k"],
      ["󱩔", "high"],
      ["", expected],
    ]) {
      expect(theme.fg).toHaveBeenCalledWith("muted", icon);
      expect(theme.fg).toHaveBeenCalledWith("dim", label);
      expect(lines[0]).toContain(
        `${ANSI.fg.white}${icon}${ANSI.reset.fg} ${ANSI.fg.brightBlack}${label}${ANSI.reset.fg}`,
      );
    }
    expect(lines[0]).toContain(
      `${ANSI.fg.brightBlack}${expected}${ANSI.reset.fg} ${ANSI.fg.brightGreen}󰓅 36.1%${ANSI.reset.fg}`,
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
  [50, "██░░", "brightGreen"],
  [50.1, "██▓░", "yellow"],
  [60, "██▓░", "yellow"],
  [63.1, "██▓░", "yellow"],
  [75, "███░", "yellow"],
  [75.1, "███▓", "red"],
  [80, "███▓", "red"],
] as const)(
  "matches the context icon and percentage to the gauge at %s percent with %s in %s",
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
      `${ANSI.fg[color]}󰓅 ${percent.toFixed(1)}%${ANSI.reset.fg} ${ANSI.fg[color]}${bar}${ANSI.reset.fg}`,
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
  expect(lines).toHaveLength(4);
  expect(stripVTControlCharacters(lines[0] ?? "")).toMatch(
    /^ 󱘖 openai-codex  test-model · 272k 󱩔 high {2,} 90.0% 󰓅 36.1% █▓░░ $/,
  );
  expect(lines[0]).toContain(`${ANSI.fg.brightGreen}█▓░░${ANSI.reset.fg}`);
  expect(visibleWidth(lines[0] ?? "")).toBe(120);
  expect(lines[1]).toBe("");
  expectFullWidthLocation(lines[2], "  /workspace   main  ", 120);
  expect(lines[3]).toBe("First Second line");

  sessionManager.appendMessage(assistant(200, 800));
  ctx.thinkingLevel = "off";
  ctx.getContextUsage = () => ({
    tokens: 102_400,
    percent: 80,
    contextWindow: 128_000,
  });
  expect(footer.render(120)[0]).toContain(
    `${ANSI.fg.red}󰓅 80.0%${ANSI.reset.fg} ${ANSI.fg.red}███▓${ANSI.reset.fg}`,
  );
  expect(footer.render(120)[0]).toContain(" test-model · 128k 󰹐 off");
  ctx.getContextUsage = () => ({
    tokens: null,
    percent: null,
    contextWindow: 272_000,
  });
  expect(stripVTControlCharacters(footer.render(120)[0] ?? "")).toContain(
    " 80.0% 󰓅 ?",
  );
  expect(footer.render(120)[0]).toContain(" test-model · 272k 󰹐 off");
  expect(footer.render(120)[0]).not.toMatch(/[█▓░$]/);
  ctx.model = undefined;
  ctx.getContextUsage = () => undefined;
  expect(stripVTControlCharacters(footer.render(120)[0] ?? "")).toMatch(
    /^ no-model · \? {2,} 80.0% 󰓅 \? $/,
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
    expect(stats).toContain(`󱘖 openai-codex  test-model · ${expected} 󱩔 high`);
    expect(stats).toMatch(/ {2,} \? 󰓅 \? $/);
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
    const fg = vi.spyOn(theme, "fg");
    const footer = createFooter(ctx, tui, theme, footerData);
    expect(stripVTControlCharacters(footer.render(120)[0] ?? "")).toContain(
      `󱘖 openai-codex  test-model · 272k ${label}`,
    );
    const [icon, effort] = label.split(" ");
    expect(fg).toHaveBeenCalledWith("muted", icon);
    expect(fg).toHaveBeenCalledWith("dim", effort);
    footer.dispose();
  },
);

test("omits thinking effort for non-reasoning and missing models", () => {
  const { ctx, tui, theme, footerData } = fixture();
  if (!ctx.model) throw new Error("Missing fixture model");
  ctx.model.reasoning = false;
  const footer = createFooter(ctx, tui, theme, footerData);
  expect(stripVTControlCharacters(footer.render(120)[0] ?? "")).toMatch(
    /^ 󱘖 openai-codex  test-model · 272k {2,} \? 󰓅 36.1% █▓░░ $/,
  );
  ctx.model = undefined;
  expect(stripVTControlCharacters(footer.render(120)[0] ?? "")).toMatch(
    /^ no-model · 272k {2,} \? 󰓅 36.1% █▓░░ $/,
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
  let iconColor = "37";
  const theme = {
    fg: (role: string, text: string) =>
      `\u001b[${role === "muted" ? iconColor : color}m${text}\u001b[0m`,
  };
  const footer = createFooter(ctx, tui, theme, footerData);
  expect(footer.render(80)[0]).toContain(
    "\u001b[37m󱘖\u001b[0m \u001b[2mopenai-codex\u001b[0m",
  );
  expect(footer.render(0)).toEqual([]);
  for (const width of [1, 2, 3, 10, 40, 80, 120]) {
    const lines = footer.render(width);
    expect(lines[0]?.startsWith(" ")).toBe(true);
    expect(lines[0]?.endsWith(" ")).toBe(true);
    expect(visibleWidth(lines[0] ?? "")).toBe(width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line).not.toMatch(/[\r\n\t]/);
    }
  }
  color = "36";
  iconColor = "97";
  footer.invalidate();
  expect(footer.render(80)[0]).toContain(
    `${ANSI.fg.brightGreen}󰓅 36.1%${ANSI.reset.fg} ${ANSI.fg.brightGreen}█▓░░${ANSI.reset.fg}`,
  );
  expect(footer.render(80)[0]).toContain(
    `\u001b[97m\u001b[0m \u001b[36m?\u001b[0m ${ANSI.fg.brightGreen}󰓅 36.1%${ANSI.reset.fg}`,
  );
  expect(footer.render(80)[0]).toContain(
    "\u001b[97m󱘖\u001b[0m \u001b[36mopenai-codex\u001b[0m \u001b[97m\u001b[0m \u001b[36mtest-model · 272k\u001b[0m \u001b[97m󱩔\u001b[0m \u001b[36mhigh\u001b[0m",
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
