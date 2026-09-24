// These use the terminal's 16-color palette, independent of Pi's theme.
export const ANSI = {
  fg: {
    black: "\x1b[30m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    brightBlack: "\x1b[90m",
    brightRed: "\x1b[91m",
    brightGreen: "\x1b[92m",
    brightYellow: "\x1b[93m",
    brightBlue: "\x1b[94m",
    brightMagenta: "\x1b[95m",
    brightCyan: "\x1b[96m",
    brightWhite: "\x1b[97m",
  },
  bg: {
    black: "\x1b[40m",
    red: "\x1b[41m",
    green: "\x1b[42m",
    yellow: "\x1b[43m",
    blue: "\x1b[44m",
    magenta: "\x1b[45m",
    cyan: "\x1b[46m",
    white: "\x1b[47m",
    brightBlack: "\x1b[100m",
    brightRed: "\x1b[101m",
    brightGreen: "\x1b[102m",
    brightYellow: "\x1b[103m",
    brightBlue: "\x1b[104m",
    brightMagenta: "\x1b[105m",
    brightCyan: "\x1b[106m",
    brightWhite: "\x1b[107m",
  },
  reset: {
    fg: "\x1b[39m",
    bg: "\x1b[49m",
    all: "\x1b[0m",
  },
} as const;

export type AnsiColor = keyof typeof ANSI.fg;
export type TerminalColor = AnsiColor | `#${string}`;

export function colorCode(layer: "fg" | "bg", color: TerminalColor): string {
  if (!color.startsWith("#")) return ANSI[layer][color as AnsiColor];
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new Error(`Invalid hex color: ${color}`);
  }
  const rgb = [1, 3, 5]
    .map((start) => Number.parseInt(color.slice(start, start + 2), 16))
    .join(";");
  return `\x1b[${layer === "fg" ? 38 : 48};2;${rgb}m`;
}
