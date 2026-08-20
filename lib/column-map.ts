/**
 * Work out which column holds which field, in any language.
 *
 * Three layers, deliberately in this order:
 *
 * 1. Value shape. An email column is found by looking at what is *in* it, not
 *    what it is called, so this works for any language or column order and is
 *    the one thing that must not be guessed — it is the required field and the
 *    dedupe key.
 * 2. Gemini, given the headers and per-column statistics. This is what makes
 *    arbitrary languages work without maintaining keyword lists for each.
 * 3. Keyword matching, as the fallback when there is no API key or the call
 *    fails. An upload should never fail just because the model is unavailable.
 *
 * Only headers and statistics are sent to the model — never cell values. These
 * files hold real people's names, emails and phone numbers, and the statistics
 * are stronger evidence than sample rows would be anyway.
 */

import { GoogleGenAI, Type } from "@google/genai";
import { STRUCTURE_MODEL } from "./config";

export type ColumnStats = {
  header: string;
  /** Share of non-empty values matching each shape, 0-1. */
  email: number;
  phone: number;
  url: number;
  date: number;
  numeric: number;
  filled: number;
  avgLength: number;
  /** Distinct values / total, so id-like columns are recognisable. */
  distinct: number;
};

export type ColumnMap = {
  email?: string;
  company?: string;
  jobTitle?: string;
  surname?: string;
  name?: string;
  notes: string[];
  /** How the mapping was decided, for the UI to show. */
  method: "ai" | "keywords";
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const PHONE = /^[+\d][\d\s()\-.]{6,}$/;
const URL_RE = /^(https?:\/\/|www\.)/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{2,4}/;
const NUMERIC = /^-?[\d,.]+$/;

export function profileColumns(records: Record<string, string>[]): ColumnStats[] {
  const headers = Object.keys(records[0] ?? {});
  // A sample is enough to characterise a column and keeps big files fast.
  const sample = records.slice(0, 300);

  return headers.map((header) => {
    const values = sample.map((r) => (r[header] ?? "").trim());
    const filled = values.filter(Boolean);
    const share = (fn: (v: string) => boolean) =>
      filled.length ? filled.filter(fn).length / filled.length : 0;

    return {
      header,
      email: share((v) => EMAIL.test(v)),
      phone: share((v) => PHONE.test(v)),
      url: share((v) => URL_RE.test(v)),
      date: share((v) => DATE_RE.test(v)),
      numeric: share((v) => NUMERIC.test(v)),
      filled: values.length ? filled.length / values.length : 0,
      avgLength: filled.length
        ? Math.round(filled.reduce((a, v) => a + v.length, 0) / filled.length)
        : 0,
      distinct: filled.length ? new Set(filled).size / filled.length : 0,
    };
  });
}

/** The column whose values actually are email addresses. */
export function detectEmailColumn(stats: ColumnStats[]): string | undefined {
  const best = [...stats].sort((a, b) => b.email - a.email)[0];
  return best && best.email >= 0.5 ? best.header : undefined;
}

const FIELD_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    company: { type: Type.STRING, nullable: true },
    jobTitle: { type: Type.STRING, nullable: true },
    surname: { type: Type.STRING, nullable: true },
    name: { type: Type.STRING, nullable: true },
    notes: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  propertyOrdering: ["company", "jobTitle", "surname", "name", "notes"],
  required: ["company", "jobTitle", "surname", "name", "notes"],
};

const SYSTEM = `You map spreadsheet columns from a sales lead export onto known fields. Headers may be in any language.

Return the exact header string for each field, or null if that field is not present. Rules:

- company: the organisation the lead belongs to. Not the person.
- name: the lead's personal name. If the export splits family and given names, put the family-name column in \`surname\` and the given/display-name column in \`name\`. A header meaning "company name" is never the person's name.
- jobTitle: their role or job title.
- notes: every column carrying free text the lead wrote or chose that would help research them — enquiry text, requirements, comments, industry or sector. Return an array, empty if none.
- Never return a header that is not in the list you were given.
- Ignore internal columns: record ids, checksums, timestamps, row numbers, system status, and anything marked do-not-modify.
- Do not map phone numbers to any field.

The statistics describe what each column contains and are usually more reliable than the header text. A column that is mostly a single repeated value, or almost entirely unique long random strings, is an internal column rather than a real field.`;

/**
 * Ask Gemini to map the semantic columns. Returns undefined when unavailable,
 * so the caller can fall back rather than failing the upload.
 */
export async function mapColumnsWithAI(
  stats: ColumnStats[],
): Promise<Omit<ColumnMap, "method" | "email"> | undefined> {
  if (!process.env.GOOGLE_API_KEY) return undefined;

  const table = stats
    .map(
      (s) =>
        `"${s.header}" — filled ${(s.filled * 100) | 0}%, distinct ${(s.distinct * 100) | 0}%, ` +
        `avg length ${s.avgLength}` +
        (s.email > 0.3 ? `, looks like email ${(s.email * 100) | 0}%` : "") +
        (s.phone > 0.3 ? `, looks like phone ${(s.phone * 100) | 0}%` : "") +
        (s.url > 0.3 ? `, looks like url ${(s.url * 100) | 0}%` : "") +
        (s.date > 0.3 ? `, looks like date ${(s.date * 100) | 0}%` : "") +
        (s.numeric > 0.5 ? `, numeric ${(s.numeric * 100) | 0}%` : ""),
    )
    .join("\n");

  try {
    const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
    const res = await client.models.generateContent({
      model: STRUCTURE_MODEL,
      contents: `Columns:\n${table}`,
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: "application/json",
        responseSchema: FIELD_SCHEMA,
        temperature: 0,
      },
    });
    if (!res.text) return undefined;

    const raw = JSON.parse(res.text) as Record<string, unknown>;
    const headers = new Set(stats.map((s) => s.header));
    // The model is told not to invent headers; verify rather than trust.
    const pick = (v: unknown) =>
      typeof v === "string" && headers.has(v) ? v : undefined;

    return {
      company: pick(raw.company),
      jobTitle: pick(raw.jobTitle),
      surname: pick(raw.surname),
      name: pick(raw.name),
      notes: Array.isArray(raw.notes)
        ? (raw.notes.map(pick).filter(Boolean) as string[])
        : [],
    };
  } catch {
    return undefined;
  }
}
