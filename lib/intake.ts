/**
 * File intake: turn an uploaded CSV or XLSX into the same `Lead` shape the
 * Notion reader produces, so everything downstream is unchanged.
 *
 * Column names are matched loosely rather than fixed, because these files come
 * from whatever tool exported them — "Company Name", "company", and
 * "COMPANY_NAME" all mean the same thing. Only an email column is required;
 * without one there is nothing to identify or dedupe a lead by.
 */

import { rowsToRecords, toRecords } from "./csv";
import { classify, researchLanguage } from "./triage";
import type { Lead } from "./types";

/** Accepted header spellings, best match first. */
const COLUMNS = {
  email: ["email", "email address", "e-mail", "mail", "contact email"],
  name: ["lead name", "full name", "name", "contact name", "contact"],
  company: ["company name", "company", "organisation", "organization", "account", "business"],
  jobTitle: ["job title", "title", "role", "position"],
  notes: [
    "biggest challenges", "challenges", "message", "notes", "lead notes",
    "comments", "enquiry", "inquiry", "description", "lead source", "source",
  ],
} as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function findColumn(headers: string[], candidates: readonly string[]): string | undefined {
  const wanted = candidates.map(norm);
  // Exact match first, so "email" beats "email_verified" when both are present.
  for (const w of wanted) {
    const hit = headers.find((h) => norm(h) === w);
    if (hit) return hit;
  }
  for (const w of wanted) {
    const hit = headers.find((h) => norm(h).includes(w));
    if (hit) return hit;
  }
  return undefined;
}

/** Every column matching a notes-ish name, so nothing the lead wrote is lost. */
function noteColumns(headers: string[]): string[] {
  const wanted = COLUMNS.notes.map(norm);
  return headers.filter((h) => wanted.some((w) => norm(h).includes(w)));
}

async function readXlsx(buffer: ArrayBuffer): Promise<string[][]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error("The workbook has no sheets.");

  const grid: string[][] = [];
  sheet.eachRow((row) => {
    const out: string[] = [];
    // `values` is 1-indexed and sparse; walk by column count instead.
    for (let c = 1; c <= sheet.columnCount; c++) {
      const v = row.getCell(c).value as any;
      if (v == null) out.push("");
      else if (typeof v === "object") {
        // Formulas, hyperlinks and rich text arrive as objects.
        out.push(String(v.result ?? v.text ?? v.hyperlink ?? ""));
      } else out.push(String(v));
    }
    grid.push(out);
  });
  return grid;
}

export type IntakeResult = {
  /** Researchable, deduped by email. */
  queue: Lead[];
  /** Classified as not worth researching, with the reason. */
  skipped: Lead[];
  /** Rows with no usable email address. */
  unusable: number;
  /** Which column each field was read from, so the UI can show the mapping. */
  mapping: Record<string, string | undefined>;
  sourceName: string;
};

/**
 * Parse an uploaded file into leads. `.xlsx` reads the first worksheet;
 * anything else is treated as CSV.
 */
export async function readIntakeFile(
  filename: string,
  data: ArrayBuffer,
): Promise<IntakeResult> {
  const records = filename.toLowerCase().endsWith(".xlsx")
    ? rowsToRecords(await readXlsx(data))
    : toRecords(new TextDecoder().decode(data));

  if (!records.length) throw new Error("No rows found in the file.");

  const headers = Object.keys(records[0]);
  const map = {
    email: findColumn(headers, COLUMNS.email),
    name: findColumn(headers, COLUMNS.name),
    company: findColumn(headers, COLUMNS.company),
    jobTitle: findColumn(headers, COLUMNS.jobTitle),
  };

  if (!map.email) {
    throw new Error(
      `No email column found. Looked for ${COLUMNS.email.join(", ")}. ` +
        `Columns present: ${headers.join(", ")}`,
    );
  }

  const notes = noteColumns(headers);
  const byEmail = new Map<string, Lead>();
  let unusable = 0;

  for (const [i, r] of records.entries()) {
    const email = (r[map.email] ?? "").trim().toLowerCase();
    if (!email.includes("@")) {
      unusable++;
      continue;
    }

    const name = map.name ? (r[map.name] ?? "").trim() : "";
    const company = map.company ? (r[map.company] ?? "").trim() : "";
    const message = notes
      .map((c) => (r[c] ? `${c}: ${r[c]}` : ""))
      .filter(Boolean)
      .join("\n");

    const existing = byEmail.get(email);
    // Same merge rule as the Notion reader: later rows fill gaps, never erase.
    const lead: Lead = {
      // No Notion page behind these, so the row index stands in as the id.
      id: existing?.id ?? `file:${i}`,
      url: "",
      email,
      name: (name.toLowerCase() === email ? "" : name) || existing?.name || "",
      company: company || existing?.company || "",
      jobTitle: (map.jobTitle ? (r[map.jobTitle] ?? "").trim() : "") || existing?.jobTitle || "",
      message: message || existing?.message || "",
      segment: "Unresearchable",
      skipReason: "",
      language: "en",
    };

    const { segment, skipReason } = classify(lead);
    lead.segment = segment;
    lead.skipReason = skipReason;
    lead.language = researchLanguage(lead);

    byEmail.set(email, lead);
  }

  const queue: Lead[] = [];
  const skipped: Lead[] = [];
  for (const lead of byEmail.values()) {
    (lead.segment === "Business domain" || lead.segment === "Free-mail + company"
      ? queue
      : skipped
    ).push(lead);
  }

  return {
    queue,
    skipped,
    unusable,
    mapping: { ...map, notes: notes.join(", ") || undefined },
    sourceName: filename,
  };
}
