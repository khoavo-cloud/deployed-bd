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
  email: [
    "email", "email address", "e-mail", "mail", "contact email",
    "電子郵件", "電子信箱", "電郵", "信箱", "郵件", "邮箱", "メール", "이메일",
  ],
  company: [
    "company name", "company", "organisation", "organization", "account", "business",
    "公司名稱", "公司名称", "公司", "企業名稱", "企業", "企业", "服務單位", "單位",
    "会社名", "회사",
  ],
  jobTitle: [
    "job title", "title", "role", "position",
    "職稱", "职称", "職位", "职位", "頭銜", "役職", "직위",
  ],
  /** Family name, where an export splits it from the given name. */
  surname: ["surname", "last name", "family name", "姓氏", "姓"],
  name: [
    "lead name", "full name", "person name", "contact name", "contact person",
    "name", "contact",
    "姓名", "全名", "聯絡人", "联系人", "名稱", "名称", "名字", "氏名", "이름",
  ],
  notes: [
    "biggest challenges", "challenges", "message", "notes", "lead notes",
    "comments", "enquiry", "inquiry", "description", "lead source", "source",
    "產業別", "产业别", "產業", "行業", "行业", "備註", "备注", "需求", "留言",
  ],
} as const;

/**
 * Lowercase and strip punctuation and spacing, but keep letters and digits in
 * any script. Stripping to `[a-z0-9]` erased CJK headers entirely, so a
 * Chinese-language export matched nothing and failed as "no email column".
 */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Resolve one field to a column, ignoring any column already claimed.
 *
 * Exclusivity matters because the loose matching is deliberately greedy: a
 * header called "company_name" contains "name", so without claiming it would
 * satisfy both `company` and `name` and the real person-name column would be
 * dropped. Fields are therefore resolved most-specific-first in COLUMNS order.
 */
function findColumn(
  headers: string[],
  candidates: readonly string[],
  taken: Set<string>,
): string | undefined {
  const free = headers.filter((h) => !taken.has(h));
  const wanted = candidates.map(norm);

  // Exact match first, so "email" beats "email_verified" when both are present.
  for (const w of wanted) {
    const hit = free.find((h) => norm(h) === w);
    if (hit) return hit;
  }
  for (const w of wanted) {
    const hit = free.find((h) => norm(h).includes(w));
    if (hit) return hit;
  }
  return undefined;
}

const HAN = /\p{Script=Han}/u;

/**
 * Rejoin a name an export split into surname and given-name columns.
 *
 * CRM exports often carry both, and some repeat the same value in each — this
 * file has 名稱 and 姓氏 both reading "Alfee" — so identical halves collapse to
 * one. Han-script names join without a space and surname first, which is the
 * order they are written in.
 */
function joinName(surname: string, given: string): string {
  if (!surname) return given;
  if (!given || surname === given) return surname;
  return HAN.test(surname + given) ? `${surname}${given}` : `${given} ${surname}`;
}

/** Every remaining notes-ish column, so nothing the lead wrote is lost. */
function noteColumns(headers: string[], taken: Set<string>): string[] {
  const wanted = COLUMNS.notes.map(norm);
  return headers.filter((h) => !taken.has(h) && wanted.some((w) => norm(h).includes(w)));
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

  // Resolution order is significant: each field claims its column, so the
  // narrower fields get first refusal before the looser ones run.
  const taken = new Set<string>();
  const claim = (candidates: readonly string[]) => {
    const hit = findColumn(headers, candidates, taken);
    if (hit) taken.add(hit);
    return hit;
  };

  const map = {
    email: claim(COLUMNS.email),
    company: claim(COLUMNS.company),
    jobTitle: claim(COLUMNS.jobTitle),
    surname: claim(COLUMNS.surname),
    name: claim(COLUMNS.name),
  };

  if (!map.email) {
    throw new Error(
      `No email column found. Looked for ${COLUMNS.email.join(", ")}. ` +
        `Columns present: ${headers.join(", ")}`,
    );
  }

  const notes = noteColumns(headers, taken);
  const byEmail = new Map<string, Lead>();
  let unusable = 0;

  for (const [i, r] of records.entries()) {
    const email = (r[map.email] ?? "").trim().toLowerCase();
    if (!email.includes("@")) {
      unusable++;
      continue;
    }

    const name = joinName(
      map.surname ? (r[map.surname] ?? "").trim() : "",
      map.name ? (r[map.name] ?? "").trim() : "",
    );
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
