/**
 * Cheap, offline classification of a lead — no API calls, no research.
 *
 * Two thirds of inbound submissions come from consumer mailboxes, so the first
 * question is not "how good is this lead" but "is there anything here to
 * research at all". A consumer address with no company name gives research
 * nothing to work with and returns nothing; those are marked Unresearchable and
 * skipped rather than discovered at the end of a full web-search pass.
 *
 * Shared by scripts/triage.ts (CSV) and lib/notion.ts (live Notion reads) so a
 * lead is classified identically wherever it enters the system.
 */

/** Consumer mailbox providers — an address here tells us nothing about a company. */
export const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.jp", "yahoo.co.uk",
  "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "msn.com",
  "icloud.com", "me.com", "aol.com", "gmx.com", "gmx.net", "mail.com",
  "proton.me", "protonmail.com", "pm.me", "zoho.com", "yandex.ru", "mail.ru",
  "qq.com", "163.com", "126.com", "sina.com", "sina.cn", "foxmail.com",
  "naver.com", "daum.net", "hanmail.net",
]);

/** Domains that mean the submission was never real. */
export const JUNK_DOMAINS = new Set([
  "example.com", "example.org", "test.com", "test.test", "email.com",
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "yopmail.com", "trashmail.com", "sharklasers.com",
]);

export type Segment =
  | "Business domain"
  | "Free-mail + company"
  | "Unresearchable"
  | "Junk";

export const RESEARCHABLE: Segment[] = ["Business domain", "Free-mail + company"];

export function isResearchable(segment: Segment): boolean {
  return RESEARCHABLE.includes(segment);
}

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

const CJK = /[㐀-鿿豈-﫿]/;
const HANGUL = /[가-힯ᄀ-ᇿ]/;
const KANA = /[぀-ヿ]/;

/**
 * Which language to research this company in. English-only search returns very
 * little for a Taiwanese or Chinese company, and local-language research is an
 * explicit requirement of the spec rather than a nicety.
 */
export function researchLanguage(input: {
  email: string;
  name?: string;
  company?: string;
}): "en" | "zh" | "ja" | "ko" {
  const domain = domainOf(input.email);
  const tld = domain.split(".").pop() ?? "";
  const text = `${input.name ?? ""} ${input.company ?? ""}`;

  if (KANA.test(text) || tld === "jp") return "ja";
  if (HANGUL.test(text) || tld === "kr") return "ko";
  if (CJK.test(text)) return "zh";
  if (["tw", "hk", "cn"].includes(tld)) return "zh";
  if (["qq.com", "163.com", "126.com", "foxmail.com", "sina.com", "sina.cn"].includes(domain))
    return "zh";
  return "en";
}

export function classify(input: { email: string; company?: string }): {
  segment: Segment;
  skipReason: string;
} {
  const email = input.email.trim().toLowerCase();
  const domain = domainOf(email);

  if (!email.includes("@") || !domain.includes("."))
    return { segment: "Junk", skipReason: "Malformed email address" };

  if (JUNK_DOMAINS.has(domain))
    return { segment: "Junk", skipReason: `Test or disposable domain (${domain})` };

  if (!FREE_MAIL.has(domain)) return { segment: "Business domain", skipReason: "" };

  if (input.company?.trim())
    return { segment: "Free-mail + company", skipReason: "" };

  return {
    segment: "Unresearchable",
    skipReason: "Consumer email and no company name — nothing to research",
  };
}
