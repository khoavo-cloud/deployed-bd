/**
 * Minimal RFC-4180 CSV reading and writing.
 *
 * Lead exports routinely carry commas inside company names and newlines inside
 * free-text answers, so splitting on "," corrupts real data. No dependency
 * needed for this much.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") continue;
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((f) => f.trim()));
}

/** Parse to objects keyed by header. Strips the BOM Excel writes. */
export function toRecords(text: string): Record<string, string>[] {
  return rowsToRecords(parseCsv(text.replace(/^﻿/, "")));
}

/** Shared by the CSV and XLSX paths — both arrive as a grid of strings. */
export function rowsToRecords(rows: string[][]): Record<string, string>[] {
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) =>
    Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])),
  );
}

const cell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => cell(r[h])).join(",")),
  ].join("\n");
}
