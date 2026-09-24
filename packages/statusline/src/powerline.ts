import { stripVTControlCharacters } from "node:util";
import { ANSI, type AnsiColor } from "./ansi.ts";

export const POWERLINE = {
  left: "",
  right: "",
  separator: "",
} as const;

export interface PowerlineSegment {
  text: string;
  background: AnsiColor;
  foreground?: AnsiColor;
}

export function powerline(segments: readonly PowerlineSegment[]): string {
  const first = segments[0];
  if (!first) return "";

  let result = ANSI.reset.bg + ANSI.fg[first.background] + POWERLINE.left;
  for (const [index, segment] of segments.entries()) {
    // Embedded resets would punch holes in the background; colors belong to the segment.
    const text = stripVTControlCharacters(segment.text).replace(
      /\r\n|[\r\n\t]/g,
      " ",
    );
    result +=
      ANSI.bg[segment.background] +
      ANSI.fg[segment.foreground ?? "black"] +
      ` ${text} `;

    const next = segments[index + 1];
    result += next
      ? ANSI.fg[segment.background] +
        ANSI.bg[next.background] +
        POWERLINE.separator
      : ANSI.reset.bg + ANSI.fg[segment.background] + POWERLINE.right;
  }
  return result + ANSI.reset.fg;
}
