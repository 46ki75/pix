import type { ColorToken } from "./tokens.ts";

export type InspectedColor =
  | { kind: "rgb"; hex: string }
  | { kind: "indexed"; index: number }
  | { kind: "default" }
  | { kind: "unknown"; ansi: string };

export function inspectColor(
  ansi: string,
  kind: ColorToken["kind"],
): InspectedColor {
  const prefix = kind === "foreground" ? 38 : 48;
  if (ansi === `\u001b[${prefix + 1}m`) return { kind: "default" };

  // Pi emits a single SGR color sequence. Do not interpret arbitrary terminal commands.
  const match = ansi.startsWith("\u001b[")
    ? /^(38|48);(2|5);(\d+(?:;\d+)*)m$/.exec(ansi.slice(2))
    : null;
  if (match && Number(match[1]) === prefix) {
    const values = match[3]?.split(";").map(Number) ?? [];
    if (
      values.every(
        (value) => Number.isInteger(value) && value >= 0 && value <= 255,
      )
    ) {
      if (match[2] === "2" && values.length === 3) {
        return {
          kind: "rgb",
          hex: `#${values.map((value) => value.toString(16).padStart(2, "0")).join("")}`,
        };
      }
      if (match[2] === "5" && values.length === 1 && values[0] !== undefined) {
        return { kind: "indexed", index: values[0] };
      }
    }
  }
  return { kind: "unknown", ansi };
}

export function describeColor(color: InspectedColor): string {
  switch (color.kind) {
    case "rgb":
      return color.hex;
    case "indexed":
      return `index ${color.index}`;
    case "default":
      return "terminal default";
    case "unknown":
      return `unknown ${JSON.stringify(color.ansi)}`;
  }
}
