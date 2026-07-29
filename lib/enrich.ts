import { GoogleGenAI, Type } from "@google/genai";
import { RESEARCH_MODEL, STRUCTURE_MODEL } from "./config";
import { recommendationFor, THRESHOLD_NOTE } from "./scoring";
import type { Lead, Profile } from "./types";

const client = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

const RESEARCH_SYSTEM = `You are a business-development analyst qualifying inbound leads for an AI video/model platform (Seedance and related AI models).

For the lead you are given, research the company behind it and report what you actually found. Search in the company's local language as well as English — many of these leads are non-English-speaking companies whose real footprint is invisible in English-only searches.

Cover:
1. Is this a legitimate, operating business? Cite what proves it (registration, funded rounds, a real product, press, an active site) or what makes you doubt it.
2. Is it a relevant AI business — would it plausibly buy AI video/model capacity? Say what they do, not just that they mention AI.
3. Does the inbound contact hold a real role at that company? Check the email domain against the company's actual domain. A free-mail address at a real company is a signal worth stating.
4. If the contact is wrong, absent, or too junior to buy, who are the senior people who would decide? Name only people you found evidence for, and say where you found each one.
5. How much usage would they plausibly need? Base it on company size, product, and any volume they stated themselves.

Rules that matter:
- Do not invent people, titles, or URLs. If you cannot find a decision maker, say so — an empty list is a correct answer.
- LinkedIn cannot be scraped. Give a LinkedIn URL only when a search result surfaced it directly; otherwise leave it out rather than constructing one.
- Distinguish what you verified from what you inferred. Say "inferred" where you inferred.
- Many of these leads are individuals or tiny operations using a consumer email address. That is a normal finding, not a failure — report it plainly.`;

/**
 * Gemini's responseSchema is an OpenAPI 3.0 subset, not full JSON Schema:
 * nullability is `nullable: true` rather than a type union, and
 * `additionalProperties` is unsupported. `propertyOrdering` is set because
 * Gemini's output quality degrades when field order drifts from the schema.
 */
const PROFILE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    companyName: { type: Type.STRING },
    website: { type: Type.STRING, nullable: true },
    linkedin: { type: Type.STRING, nullable: true },
    country: { type: Type.STRING, nullable: true },
    industry: { type: Type.STRING, nullable: true },
    summary: { type: Type.STRING },
    scores: {
      type: Type.OBJECT,
      properties: {
        legitBusiness: { type: Type.INTEGER },
        relevantAI: { type: Type.INTEGER },
        contactSeniority: { type: Type.INTEGER },
        usagePotential: { type: Type.INTEGER },
        total: { type: Type.INTEGER },
      },
      propertyOrdering: [
        "legitBusiness",
        "relevantAI",
        "contactSeniority",
        "usagePotential",
        "total",
      ],
      required: [
        "legitBusiness",
        "relevantAI",
        "contactSeniority",
        "usagePotential",
        "total",
      ],
    },
    aiRelevance: {
      type: Type.STRING,
      enum: ["High", "Medium", "Low", "Not relevant"],
    },
    contact: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, nullable: true },
        title: { type: Type.STRING, nullable: true },
        seniority: {
          type: Type.STRING,
          enum: ["Junior", "Mid", "Senior", "Decision-maker", "Unverified"],
        },
        isWrongContact: { type: Type.BOOLEAN },
      },
      propertyOrdering: ["name", "title", "seniority", "isWrongContact"],
      required: ["name", "title", "seniority", "isWrongContact"],
    },
    decisionMakers: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          title: { type: Type.STRING },
          linkedin: { type: Type.STRING, nullable: true },
          evidence: { type: Type.STRING },
        },
        propertyOrdering: ["name", "title", "linkedin", "evidence"],
        required: ["name", "title", "linkedin", "evidence"],
      },
    },
    dmConfidence: {
      type: Type.STRING,
      enum: ["Confirmed", "Inferred", "None"],
    },
    usageEstimate: {
      type: Type.STRING,
      enum: ["Unknown", "Small", "Medium", "Large", "Enterprise"],
    },
    usageRationale: { type: Type.STRING },
    // `recommendation` is deliberately absent — it is derived from the total in
    // lib/scoring.ts, not chosen by the model. Only the reasoning comes from here.
    recommendationRationale: { type: Type.STRING },
  },
  propertyOrdering: [
    "companyName",
    "website",
    "linkedin",
    "country",
    "industry",
    "summary",
    "scores",
    "aiRelevance",
    "contact",
    "decisionMakers",
    "dmConfidence",
    "usageEstimate",
    "usageRationale",
    "recommendationRationale",
  ],
  required: [
    "companyName",
    "website",
    "linkedin",
    "country",
    "industry",
    "summary",
    "scores",
    "aiRelevance",
    "contact",
    "decisionMakers",
    "dmConfidence",
    "usageEstimate",
    "usageRationale",
    "recommendationRationale",
  ],
};

const LANGUAGE_NAME: Record<Lead["language"], string> = {
  en: "English",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
};

function leadBrief(lead: Lead) {
  return [
    `Contact name: ${lead.name || "(not given)"}`,
    `Email: ${lead.email || "(not given)"}`,
    `Company as stated: ${lead.company || "(not given)"}`,
    `Job title as stated: ${lead.jobTitle || "(not given)"}`,
    `Lead segment: ${lead.segment}`,
    `Likely research language: ${LANGUAGE_NAME[lead.language]}`,
    `What they submitted:\n${lead.message || "(nothing)"}`,
  ].join("\n");
}

/**
 * Citations Google actually returned, rather than URLs the model recited.
 *
 * The uri is a vertexaisearch redirect that expires after roughly a month, so
 * the source title is kept alongside it — otherwise the audit trail in Notion
 * turns into a column of dead links.
 */
function groundingUrls(response: any): string[] {
  const seen = new Map<string, string>();
  for (const candidate of response.candidates ?? []) {
    for (const chunk of candidate.groundingMetadata?.groundingChunks ?? []) {
      const uri = chunk.web?.uri;
      if (uri) seen.set(uri, chunk.web?.title ?? "");
    }
  }
  return [...seen].map(([uri, title]) => (title ? `${title} — ${uri}` : uri));
}

/**
 * Step 1 — open-ended research with Google Search grounding.
 *
 * Kept separate from the structuring call even though Gemini 3 can now combine
 * search with structured output: scoring the research separately stops the model
 * scoring things it never actually looked up, and grounding citations come back
 * empty when the two are combined.
 */
async function research(
  lead: Lead,
): Promise<{ findings: string; evidenceUrls: string[] }> {
  const response = await client.models.generateContent({
    model: RESEARCH_MODEL,
    contents: leadBrief(lead),
    config: {
      systemInstruction: RESEARCH_SYSTEM,
      tools: [{ googleSearch: {} }],
    },
  });

  const findings = response.text ?? "";
  if (!findings.trim()) {
    const reason = response.candidates?.[0]?.finishReason ?? "unknown";
    throw new Error(`Research returned no text (finishReason: ${reason}).`);
  }

  return { findings, evidenceUrls: groundingUrls(response) };
}

/** Step 2 — turn the research write-up into the scored profile record. */
async function structure(
  lead: Lead,
  findings: string,
  evidenceUrls: string[],
): Promise<Profile> {
  const response = await client.models.generateContent({
    model: STRUCTURE_MODEL,
    contents: `Original lead:\n${leadBrief(lead)}\n\n---\n\nResearch findings:\n${findings}`,
    config: {
      systemInstruction: `Convert the research findings into a structured lead profile.

Score each dimension 0-25 and set \`total\` to their sum:
- legitBusiness: is this a real, operating company?
- relevantAI: would they plausibly buy AI video/model capacity?
- contactSeniority: does the inbound contact hold a real, senior-enough role?
- usagePotential: how much volume could they represent?

Score only what the findings support. Absence of evidence is a low score, not a guess — and say so in \`summary\`. Carry over the findings' distinction between verified and inferred; do not upgrade an inference into a fact. Copy decision makers and URLs verbatim from the findings; never add one that isn't there.

${THRESHOLD_NOTE} Write \`recommendationRationale\` to explain the score you gave and what it means for outreach, consistent with the band that total falls into — do not argue for a different verdict.

Also set:
- aiRelevance: the band that matches relevantAI — High, Medium, Low, or "Not relevant".
- contact.seniority: the inbound contact's level. Use "Unverified" when you could not confirm they work there at all; that is different from "Junior".
- contact.isWrongContact: true whenever this person could not sign off on the purchase themselves — which includes any Junior or Unverified contact, and any case where you had to name someone more senior. It is false only when the inbound contact is themselves senior enough to decide. A perfectly genuine, useful contact can still be the wrong contact.
- dmConfidence: "Confirmed" if a decision maker was found on a citable page, "Inferred" if reasoned from role structure without a source, "None" if the list is empty. Never mark a name Confirmed without a URL behind it.
- industry: a short label like "Advertising", "Game studio", "E-commerce". Null if unknown.`,
      responseMimeType: "application/json",
      responseSchema: PROFILE_SCHEMA,
      // Structuring is transcription, not judgement — keep it deterministic.
      temperature: 0,
    },
  });

  const text = response.text;
  if (!text) throw new Error("No structured output returned.");

  const profile = JSON.parse(text) as Profile;
  // Derived, never taken from the model — see lib/scoring.ts.
  profile.recommendation = recommendationFor(profile.scores.total);
  // Citations come from Google's grounding metadata, not from the model's prose,
  // so a URL here is one that was really returned by a search.
  profile.evidenceUrls = evidenceUrls;
  return profile;
}

/** 503 and 429 are load, not bad input — back off and try again. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const transient = err?.status === 503 || err?.status === 429;
      if (!transient || i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

export async function enrichLead(
  lead: Lead,
): Promise<{ profile: Profile; findings: string }> {
  const { findings, evidenceUrls } = await withRetry(() => research(lead));
  const profile = await withRetry(() => structure(lead, findings, evidenceUrls));
  return { profile, findings };
}
