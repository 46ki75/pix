export function compact(value: string, limit: number): string {
  const text = value
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
