/** Compact rendering helpers. Tool output lands in an agent's context, so keep it dense. */

export const pct = (value: number | null): string =>
  value === null ? "—" : `${(value * 100).toFixed(1)}%`;

export const num = (value: number | null, digits = 3): string =>
  value === null ? "—" : value.toFixed(digits);

export function markdownTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
  return lines.join("\n");
}

/** Single-line preview of a state value, for error rows and spot checks. */
export function preview(value: unknown, maxLength = 90): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
  return collapsed.length <= maxLength
    ? collapsed
    : `${collapsed.slice(0, maxLength - 1)}…`;
}
