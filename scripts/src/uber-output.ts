import { writeFile } from "node:fs/promises";
import type { OutputRow } from "./types.js";

export function serializeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function generateCsv(rows: OutputRow[], columns: (keyof OutputRow)[]): string {
  const lines: string[] = [];
  lines.push(columns.join(","));
  for (const row of rows) {
    lines.push(columns.map((col) => serializeCsvCell(row[col])).join(","));
  }
  return lines.join("\n") + "\n";
}

export async function writeOutputCsv(
  path: string,
  rows: OutputRow[],
  columns: (keyof OutputRow)[],
): Promise<void> {
  const csv = generateCsv(rows, columns);
  await writeFile(path, csv, "utf8");
}
