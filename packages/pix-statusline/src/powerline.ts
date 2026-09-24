import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ANSI, colorCode, type TerminalColor } from "./ansi.ts";

export const POWERLINE = {
  left: "",
  right: "",
  separator: "",
} as const;

export interface PowerlineSegment {
  text: string;
  background: TerminalColor;
  foreground?: TerminalColor | ((text: string) => string);
}

export function powerline(
  segments: readonly PowerlineSegment[],
  width?: number,
): string {
  const first = segments[0];
  if (!first || (width !== undefined && width <= 0)) return "";

  let result =
    ANSI.reset.bg + colorCode("fg", first.background) + POWERLINE.left;
  if (width === 1) return result + ANSI.reset.fg;
  for (const [index, segment] of segments.entries()) {
    // Embedded resets would punch holes in the background; colors belong to the segment.
    const text = stripVTControlCharacters(segment.text).replace(
      /\r\n|[\r\n\t]/g,
      " ",
    );
    const remaining =
      width === undefined
        ? undefined
        : width - visibleWidth(result) - visibleWidth(POWERLINE.right);
    const next = segments[index + 1];
    // Only add a separator if the next segment has room for its two padding cells.
    const showNext =
      next &&
      (remaining === undefined ||
        visibleWidth(text) + 2 + visibleWidth(POWERLINE.separator) + 2 <=
          remaining);
    let content = ` ${text} `;
    if (!showNext && remaining !== undefined) {
      // Pi's truncation adds ANSI resets; remove them before applying segment colors.
      content =
        remaining < 2
          ? " ".repeat(remaining)
          : ` ${stripVTControlCharacters(truncateToWidth(next ? `${text} ...` : text, remaining - 2, "...", true))} `;
    }
    // Apply foreground styling last so label sanitization does not strip theme colors.
    result +=
      colorCode("bg", segment.background) +
      (typeof segment.foreground === "function"
        ? segment.foreground(content)
        : colorCode("fg", segment.foreground ?? "black") + content);

    if (showNext) {
      result +=
        colorCode("fg", segment.background) +
        colorCode("bg", next.background) +
        POWERLINE.separator;
    } else {
      result +=
        ANSI.reset.bg + colorCode("fg", segment.background) + POWERLINE.right;
      break;
    }
  }
  return result + ANSI.reset.fg;
}
