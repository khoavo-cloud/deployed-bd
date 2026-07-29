/**
 * Triage the raw web-leads CSV before anything is researched.
 *
 *   npx tsx scripts/triage.ts <path-to-csv> [--out triage.csv]
 *
 * Form submissions are not leads: the same person shows up once per funnel step,
 * so the file is collapsed to one row per email first. Each surviving lead is
 * then sorted into a segment by what we actually have to research it *with* —
 * a business domain, a self-reported company name, or nothing at all. Leads in
 * the last group cost a full research pass and return nothing, so they are
 * marked Skipped here rather than discovered later.
 *
 * Writes nothing to Notion and calls no APIs.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  classify,
  domainOf,
  isResearchable,
  researchLanguage,
  type Segment,
} from "../lib/triage";

/** Shared-inbox prefixes: real companies, but nobody in particular. */
const ROLE_PREFIXES = new Set([
  "info", "contact", "hello", "hi", "support", "sales", "admin", "team",
  "help", "office", "enquiries", "inquiries", "marketing", "press", "noreply",
  "no-reply", "billing", "webmaster", "service",
]);

type Lead = {
  email: string;
  domain: string;
  name: string;
  company: string;
  title: string;
  challenges: string;
  source: string;
  notes: string;
  createdTime: string;
  pageId: string;
  notionUrl: string;
  /** Highest funnel step this person reached across their submissions. */
  step: number;
  submissions: number;
  segment: Segment;
  language: string;
  skipReason: string;
};

// ---------------------------------------------------------------- CSV parsing

/** RFC-4180 parser — fields contain commas and quoted newlines, so no split(","). */
function parseCsv(text: string): string[][] {
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

function toRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) =>
    Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])),
  );
}

// ---------------------------------------------------------------------- merge

/**
 * Collapse submissions to one lead per email. Rows are applied oldest-first and
 * only non-empty values overwrite, so a later partial submission never erases
 * detail the person gave earlier.
 */
function mergeByEmail(records: Record<string, string>[]): Lead[] {
  const byEmail = new Map<string, Lead>();

  const ordered = [...records].sort((a, b) =>
    (a["Created Time"] ?? "").localeCompare(b["Created Time"] ?? ""),
  );

  for (const r of ordered) {
    const email = (r["Email"] ?? "").trim().toLowerCase();
    if (!email) continue;

    const existing = byEmail.get(email);
    const lead: Lead = existing ?? {
      email,
      domain: domainOf(email),
      name: "", company: "", title: "", challenges: "", source: "", notes: "",
      createdTime: "", pageId: "", notionUrl: "",
      step: 0, submissions: 0,
      segment: "Unresearchable", language: "en", skipReason: "",
    };

    // A blank name field is submitted as the email itself; that is not a name.
    const name = (r["Name"] ?? "").trim();
    if (name && name.toLowerCase() !== email) lead.name = name;

    for (const [key, col] of [
      ["company", "Company Name"],
      ["title", "Job Title"],
      ["challenges", "Biggest Challenges"],
      ["source", "Lead Source"],
      ["notes", "Lead Notes"],
      ["createdTime", "Created Time"],
      ["pageId", "Page ID"],
      ["notionUrl", "Notion URL"],
    ] as const) {
      const v = (r[col] ?? "").trim();
      if (v) (lead as any)[key] = v;
    }

    const step = Number(/step_(\d+)/.exec(r["Lead Notes"] ?? "")?.[1] ?? 0);
    lead.step = Math.max(lead.step, step);
    lead.submissions++;

    byEmail.set(email, lead);
  }

  return [...byEmail.values()];
}

// ----------------------------------------------------------------------- main

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("usage: npx tsx scripts/triage.ts <path-to-csv> [--out triage.csv]");
  process.exit(1);
}
const outFlag = process.argv.indexOf("--out");
const outPath = outFlag > -1 ? process.argv[outFlag + 1] : "triage.csv";

const records = toRecords(readFileSync(csvPath, "utf8"));
const leads = mergeByEmail(records);

for (const lead of leads) {
  const { segment, skipReason } = classify(lead);
  lead.segment = segment;
  lead.skipReason = skipReason;
  lead.language = researchLanguage(lead);
}

/** Research the strongest signals first: a real domain, then stated intent. */
const ORDER: Segment[] = ["Business domain", "Free-mail + company", "Unresearchable", "Junk"];
leads.sort((a, b) => {
  const s = ORDER.indexOf(a.segment) - ORDER.indexOf(b.segment);
  if (s) return s;
  if (a.step !== b.step) return b.step - a.step;
  return Number(!!b.challenges) - Number(!!a.challenges);
});

const HEADERS = [
  "Email", "Name", "Company Name", "Job Title", "Biggest Challenges",
  "Domain", "Segment", "Research Language", "Funnel Step", "Submissions",
  "Lead Source", "Created Time", "Skip Reason", "Page ID", "Notion URL",
] as const;

const cell = (v: string | number) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

writeFileSync(
  outPath,
  [
    HEADERS.join(","),
    ...leads.map((l) =>
      [
        l.email, l.name, l.company, l.title, l.challenges,
        l.domain, l.segment, l.language, l.step || "", l.submissions,
        l.source, l.createdTime, l.skipReason, l.pageId, l.notionUrl,
      ].map(cell).join(","),
    ),
  ].join("\n"),
  "utf8",
);

// ---------------------------------------------------------------------- report

const count = (fn: (l: Lead) => boolean) => leads.filter(fn).length;
const pct = (n: number) => `${Math.round((n / leads.length) * 100)}%`;

console.log(`\n  ${records.length} submissions → ${leads.length} unique leads\n`);

console.log("  Segment                 Leads        Researchable");
console.log("  " + "─".repeat(50));
for (const seg of ORDER) {
  const n = count((l) => l.segment === seg);
  if (!n) continue;
  const ok = isResearchable(seg);
  console.log(
    `  ${seg.padEnd(22)}  ${String(n).padStart(3)} ${pct(n).padStart(5)}   ${ok ? "yes" : "no"}`,
  );
}

const researchable = count((l) => isResearchable(l.segment));
console.log("  " + "─".repeat(50));
console.log(`  ${"To research".padEnd(22)}  ${String(researchable).padStart(3)} ${pct(researchable).padStart(5)}`);
console.log(`  ${"To skip".padEnd(22)}  ${String(leads.length - researchable).padStart(3)} ${pct(leads.length - researchable).padStart(5)}\n`);

const langs = [...new Set(leads.map((l) => l.language))]
  .map((lang) => [lang, count((l) => l.language === lang && l.segment !== "Junk")] as const)
  .filter(([, n]) => n)
  .sort((a, b) => b[1] - a[1]);
console.log(`  Research language:  ${langs.map(([l, n]) => `${l} ${n}`).join("   ")}`);

console.log(
  `  Reached final step: ${count((l) => l.step >= 2)}` +
  `   ·  Stated a challenge: ${count((l) => !!l.challenges)}` +
  `   ·  Gave a job title: ${count((l) => !!l.title)}`,
);
console.log(`  Role inboxes: ${count((l) => ROLE_PREFIXES.has(l.email.split("@")[0]))}`);
console.log(`\n  → ${outPath}\n`);
