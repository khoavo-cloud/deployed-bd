import { Client } from "@notionhq/client";
import {
  NOTION_TOKEN,
  SOURCE_DB_ID,
  SOURCE_FIELDS,
  TARGET_DB_ID,
  TARGET_FIELDS,
  TARGET_RELATION,
} from "./config";
import { classify, domainOf, isResearchable, researchLanguage } from "./triage";
import type { Lead, Profile } from "./types";

export const notion = new Client({
  auth: NOTION_TOKEN,
  notionVersion: "2022-06-28",
});

/** Pull a plain string out of whatever property type Notion hands back. */
function readText(prop: any): string {
  if (!prop) return "";
  switch (prop.type) {
    case "title":
    case "rich_text":
      return prop[prop.type].map((t: any) => t.plain_text).join("");
    case "email":
      return prop.email ?? "";
    case "url":
      return prop.url ?? "";
    case "phone_number":
      return prop.phone_number ?? "";
    case "select":
      return prop.select?.name ?? "";
    case "multi_select":
      return prop.multi_select.map((s: any) => s.name).join(", ");
    case "number":
      return prop.number == null ? "" : String(prop.number);
    case "formula":
      return String(prop.formula?.string ?? prop.formula?.number ?? "");
    default:
      return "";
  }
}

function toLead(page: any): Lead {
  const p = page.properties;
  const name = readText(p[SOURCE_FIELDS.title]);
  const email = readText(p[SOURCE_FIELDS.email]).trim().toLowerCase();
  const company = readText(p[SOURCE_FIELDS.company]);

  // The form submits the email as the name when the lead left the name blank.
  const realName = name.toLowerCase() === email ? "" : name;

  const message = SOURCE_FIELDS.message
    .map((field) => {
      const value = readText(p[field]);
      return value ? `${field}: ${value}` : "";
    })
    .filter(Boolean)
    .join("\n");

  const { segment, skipReason } = classify({ email, company });

  return {
    id: page.id,
    url: page.url,
    name: realName,
    email,
    company,
    jobTitle: readText(p[SOURCE_FIELDS.jobTitle]),
    message,
    segment,
    skipReason,
    language: researchLanguage({ email, name: realName, company }),
  };
}

/** Every email already written to BD Profiles — those leads are done. */
async function publishedEmails(): Promise<Set<string>> {
  const emails = new Set<string>();
  let cursor: string | undefined;

  do {
    const res: any = await notion.databases.query({
      database_id: TARGET_DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const page of res.results) {
      const email = readText(page.properties[TARGET_FIELDS.email]);
      if (email) emails.add(email.trim().toLowerCase());
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return emails;
}

export type LeadQueue = {
  /** Researchable and not yet in BD Profiles. */
  queue: Lead[];
  /** Consumer address with no company, or a junk domain — not worth researching. */
  skipped: Lead[];
  /** Already present in BD Profiles. */
  done: Lead[];
};

/**
 * Read the inbound database and split it into work, non-work, and done.
 *
 * The web form owns Custom: Web Leads and submits the same person once per
 * funnel step, so leads are collapsed by email here and "already processed" is
 * answered from BD Profiles. Nothing is written back to the source database.
 */
export async function listLeads(): Promise<LeadQueue> {
  const pages: any[] = [];
  let cursor: string | undefined;

  do {
    const res: any = await notion.databases.query({
      database_id: SOURCE_DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  // Oldest first, so a newer submission's non-empty values win the merge.
  pages.sort((a, b) =>
    String(a.created_time ?? "").localeCompare(String(b.created_time ?? "")),
  );

  const byEmail = new Map<string, Lead>();
  for (const page of pages) {
    const lead = toLead(page);
    if (!lead.email) continue;

    const existing = byEmail.get(lead.email);
    if (!existing) {
      byEmail.set(lead.email, lead);
      continue;
    }
    // A later partial submission must not erase detail given earlier.
    const merged: Lead = {
      ...existing,
      id: lead.id,
      url: lead.url,
      name: lead.name || existing.name,
      company: lead.company || existing.company,
      jobTitle: lead.jobTitle || existing.jobTitle,
      message: lead.message || existing.message,
    };
    // Reclassify: a company name supplied later can move a lead out of Unresearchable.
    const { segment, skipReason } = classify(merged);
    byEmail.set(lead.email, {
      ...merged,
      segment,
      skipReason,
      language: researchLanguage(merged),
    });
  }

  const published = await publishedEmails();
  const queue: Lead[] = [];
  const skipped: Lead[] = [];
  const done: Lead[] = [];

  for (const lead of byEmail.values()) {
    if (published.has(lead.email)) done.push(lead);
    else if (isResearchable(lead.segment)) queue.push(lead);
    else skipped.push(lead);
  }

  return { queue, skipped, done };
}

export async function getLead(pageId: string): Promise<Lead> {
  const page = await notion.pages.retrieve({ page_id: pageId });
  return toLead(page);
}

const richText = (s: string) => [{ text: { content: s.slice(0, 2000) } }];
const select = (name: string | null | undefined) =>
  name ? { select: { name: name.slice(0, 100) } } : null;

/**
 * Notion rejects a malformed url outright, so anything unusable becomes null.
 * The model often returns a bare "example.com" or "www.example.com", which is a
 * perfectly good answer written without a scheme — dropping those silently cost
 * us the website on most of the first batch.
 */
function toUrl(s: string | null | undefined) {
  const value = s?.trim();
  if (!value) return { url: null };
  if (/^https?:\/\//i.test(value)) return { url: value };
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(value)) return { url: `https://${value}` };
  return { url: null };
}

/**
 * A lead writing from their own company domain has already told us the website.
 * Only used when research didn't return one — never to overwrite a found value,
 * and never for consumer mailboxes, where the domain says nothing.
 */
function websiteFallback(lead: Lead): string | null {
  return lead.segment === "Business domain" ? domainOf(lead.email) : null;
}

/**
 * Write an enriched profile to BD Profiles.
 *
 * Only properties that exist on the target with a matching type are sent, so
 * schema drift can't fail the whole write — but it also can't be seen, which is
 * why this returns the list of fields it had to drop.
 */
export async function publishProfile(lead: Lead, profile: Profile) {
  const db: any = await notion.databases.retrieve({ database_id: TARGET_DB_ID });
  const schema = db.properties;

  const decisionMakers = profile.decisionMakers
    .map(
      (d) =>
        `${d.name} — ${d.title}${d.linkedin ? ` (${d.linkedin})` : ""}\n  ${d.evidence}`,
    )
    .join("\n");

  const candidates: Record<string, any> = {
    // The title is the company; the email has its own property.
    [TARGET_FIELDS.title]: {
      title: richText(profile.companyName || lead.company || lead.email),
    },
    [TARGET_FIELDS.email]: { email: lead.email || null },
    [TARGET_FIELDS.contactName]: {
      rich_text: richText(profile.contact.name ?? lead.name),
    },
    [TARGET_FIELDS.contactTitle]: {
      rich_text: richText(profile.contact.title ?? lead.jobTitle),
    },

    [TARGET_FIELDS.score]: { number: profile.scores.total },
    [TARGET_FIELDS.legitBusiness]: { number: profile.scores.legitBusiness },
    [TARGET_FIELDS.relevantAI]: { number: profile.scores.relevantAI },
    [TARGET_FIELDS.contactSeniorityScore]: {
      number: profile.scores.contactSeniority,
    },
    [TARGET_FIELDS.usagePotential]: { number: profile.scores.usagePotential },

    [TARGET_FIELDS.aiRelevance]: select(profile.aiRelevance),
    [TARGET_FIELDS.industry]: select(profile.industry),
    [TARGET_FIELDS.website]: toUrl(profile.website || websiteFallback(lead)),
    [TARGET_FIELDS.linkedin]: toUrl(profile.linkedin),
    [TARGET_FIELDS.country]: select(profile.country),
    [TARGET_FIELDS.usageEstimate]: select(profile.usageEstimate),
    [TARGET_FIELDS.usageRationale]: { rich_text: richText(profile.usageRationale) },

    [TARGET_FIELDS.contactSeniority]: select(profile.contact.seniority),
    [TARGET_FIELDS.wrongContact]: { checkbox: profile.contact.isWrongContact },
    [TARGET_FIELDS.decisionMakers]: { rich_text: richText(decisionMakers) },
    [TARGET_FIELDS.decisionMakerLinkedin]: toUrl(profile.decisionMakers[0]?.linkedin),
    [TARGET_FIELDS.dmConfidence]: select(profile.dmConfidence),

    [TARGET_FIELDS.recommendation]: select(profile.recommendation),
    [TARGET_FIELDS.recommendationRationale]: {
      rich_text: richText(profile.recommendationRationale),
    },
    [TARGET_FIELDS.summary]: { rich_text: richText(profile.summary) },
    [TARGET_FIELDS.evidenceUrls]: {
      rich_text: richText(profile.evidenceUrls.join("\n")),
    },

    [TARGET_FIELDS.status]: select("Enriched"),
    [TARGET_FIELDS.segment]: select(lead.segment),
    [TARGET_FIELDS.language]: select(lead.language),
    [TARGET_FIELDS.processedAt]: { date: { start: new Date().toISOString() } },
  };

  // Only present once the relation has been added from the Notion UI.
  if (schema[TARGET_RELATION]?.type === "relation") {
    candidates[TARGET_RELATION] = { relation: [{ id: lead.id }] };
  }

  const properties: Record<string, any> = {};
  const dropped: string[] = [];

  for (const [name, value] of Object.entries(candidates)) {
    if (value == null) continue;
    const declared = schema[name];
    if (!declared) {
      dropped.push(`${name} — not in database`);
      continue;
    }
    const kind = Object.keys(value)[0];
    if (kind !== declared.type) {
      dropped.push(`${name} — app sends ${kind}, database declares ${declared.type}`);
      continue;
    }
    properties[name] = value;
  }

  const created: any = await notion.pages.create({
    parent: { database_id: TARGET_DB_ID },
    properties: properties as any,
  });

  return { page: created, dropped };
}
