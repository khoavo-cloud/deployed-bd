import type { Segment } from "./triage";

export type Lead = {
  id: string;
  url: string;
  name: string;
  email: string;
  company: string;
  jobTitle: string;
  /** Everything the lead told us, assembled for the research prompt. */
  message: string;
  /** Assigned offline by lib/triage.ts — costs nothing, needs no research. */
  segment: Segment;
  language: "en" | "zh" | "ja" | "ko";
  skipReason: string;
};

export type Profile = {
  companyName: string;
  website: string | null;
  linkedin: string | null;
  country: string | null;
  industry: string | null;
  /** Local-language + English research summary of what the company does. */
  summary: string;
  /** Scores are 0-25 each; `total` is their sum, 0-100. */
  scores: {
    legitBusiness: number;
    relevantAI: number;
    contactSeniority: number;
    usagePotential: number;
    total: number;
  };
  /** Banded alongside the scores so Notion can group and filter on it. */
  aiRelevance: "High" | "Medium" | "Low" | "Not relevant";
  contact: {
    name: string | null;
    title: string | null;
    seniority: "Junior" | "Mid" | "Senior" | "Decision-maker" | "Unverified";
    /** true when the inbound contact is too junior or not verifiably at the company */
    isWrongContact: boolean;
  };
  /** Senior people worth reaching instead of / alongside the inbound contact. */
  decisionMakers: Array<{
    name: string;
    title: string;
    linkedin: string | null;
    /** How this person was identified — cite the source, don't invent people. */
    evidence: string;
  }>;
  /**
   * Whether those people were verified or reasoned about. With no enrichment
   * provider this is often "None", which is a real answer rather than a failure.
   */
  dmConfidence: "Confirmed" | "Inferred" | "None";
  /** Source links behind the findings, so a score can be audited. */
  evidenceUrls: string[];
  usageEstimate: "Unknown" | "Small" | "Medium" | "Large" | "Enterprise";
  usageRationale: string;
  recommendation: "Pursue" | "Nurture" | "Reject";
  recommendationRationale: string;
};
