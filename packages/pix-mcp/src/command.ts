export interface CommandToken {
  value: string;
  separator?: number;
}

export function quoteCommandArgument(value: string): string {
  return /^[A-Za-z0-9_.:/-]+$/.test(value)
    ? value
    : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderCommandToken(token: CommandToken): string {
  if (token.separator === undefined) return quoteCommandArgument(token.value);
  const name = quoteCommandArgument(token.value.slice(0, token.separator));
  const value = token.value.slice(token.separator + 1);
  return `${name}=${value === "" ? "" : quoteCommandArgument(value)}`;
}

export function tokenizeCommand(
  input: string,
  subject = "command",
): CommandToken[] {
  const tokens: CommandToken[] = [];
  let token = "";
  let separator: number | undefined;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let started = false;
  for (const character of input) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      started = true;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        tokens.push({
          value: token,
          ...(separator !== undefined ? { separator } : {}),
        });
        token = "";
        separator = undefined;
        started = false;
      }
    } else {
      if (character === "=" && separator === undefined)
        separator = token.length;
      token += character;
      started = true;
    }
  }
  if (quote) throw new Error(`Unterminated quote in ${subject} arguments.`);
  if (escaped) throw new Error(`Trailing escape in ${subject} arguments.`);
  if (started)
    tokens.push({
      value: token,
      ...(separator !== undefined ? { separator } : {}),
    });
  return tokens;
}
