/**
 * Field mapping between the two Notion databases and this app's internal shape.
 *
 * Verified against the live schemas — run `npm run inspect:notion` after any
 * change in Notion. Names must match exactly: `publishProfile` drops any
 * property whose name or declared type doesn't line up, so a typo here is
 * silent data loss rather than an error.
 */

export const NOTION_TOKEN = process.env.NOTION_TOKEN!;
export const SOURCE_DB_ID = process.env.NOTION_SOURCE_DB_ID!;
export const TARGET_DB_ID = process.env.NOTION_TARGET_DB_ID!;

/**
 * Properties read from "Custom: Web Leads".
 *
 * Nothing is written back here — the web form owns this database, and whether a
 * lead has been processed is answered by looking for its email in the target
 * database instead. See `listLeads`.
 */
export const SOURCE_FIELDS = {
  /** title property — the lead's name, or their email when they gave no name */
  title: "Name",
  /** rich_text, not an email property, in this database */
  email: "Email",
  company: "Company Name",
  jobTitle: "Job Title",
  /** Free-text fields folded into the research brief, in this order. */
  message: ["Biggest Challenges", "Lead Notes", "Lead Source"],
} as const;

/** Properties written to "BD Profiles". */
export const TARGET_FIELDS = {
  title: "Company",
  email: "Lead Email",
  contactName: "Contact Name",
  contactTitle: "Contact Title",

  score: "Composite Score",
  legitBusiness: "Legit Business",
  relevantAI: "Relevant AI",
  contactSeniorityScore: "Contact Seniority Score",
  usagePotential: "Usage Potential",

  aiRelevance: "AI Relevance",
  industry: "Industry",
  website: "Company Website",
  linkedin: "Company LinkedIn",
  country: "Country",
  usageEstimate: "Estimated AI Usage",
  usageRationale: "Usage Rationale",

  contactSeniority: "Contact Seniority",
  wrongContact: "Wrong Contact",
  decisionMakers: "Suggested Decision Maker",
  decisionMakerLinkedin: "Decision Maker LinkedIn",
  dmConfidence: "DM Confidence",

  recommendation: "Recommendation",
  recommendationRationale: "Recommendation Rationale",
  summary: "Research Notes",
  evidenceUrls: "Evidence URLs",

  status: "Status",
  error: "Error",
  segment: "Segment",
  language: "Research Language",
  processedAt: "Processed At",
} as const;

/**
 * Optional relation back to Custom: Web Leads. Notion can only create a
 * relation from the UI, so this is written only once the property exists —
 * absent is fine.
 */
export const TARGET_RELATION = "Source Lead";

/**
 * Research does the reasoning and the searching; structuring only transcribes
 * findings into the schema, so it can run on a cheaper model.
 *
 * Both default to Flash, which is what the Gemini free tier allows — Pro models
 * left the free tier in April 2026. Override to a Pro model for the research
 * call once billing is on; that is the call where model quality actually shows.
 */
export const RESEARCH_MODEL = process.env.GEMINI_RESEARCH_MODEL || "gemini-3.6-flash";
export const STRUCTURE_MODEL = process.env.GEMINI_STRUCTURE_MODEL || "gemini-3.6-flash";
