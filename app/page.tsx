"use client";

import { useEffect, useState } from "react";
import type { Lead, Profile } from "../lib/types";

type Result = { profile: Profile; findings: string };

export default function Page() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"enrich" | "publish" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<string | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  const [counts, setCounts] = useState<{
    queue: number;
    skipped: number;
    done: number;
  } | null>(null);

  useEffect(() => {
    fetch("/api/leads")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setError(d.error);
        setLeads(d.leads);
        setCounts(d.counts);
      })
      .catch((e) => setError(String(e)));
  }, []);

  function select(lead: Lead) {
    setSelected(lead);
    setResult(null);
    setError(null);
    setPublished(null);
  }

  async function enrich() {
    if (!selected) return;
    setBusy("enrich");
    setError(null);
    try {
      const res = await fetch("/api/enrich", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadId: selected.id }),
      }).then((r) => r.json());
      if (res.error) setError(res.error);
      else setResult({ profile: res.profile, findings: res.findings });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!selected || !result) return;
    setBusy("publish");
    setError(null);
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadId: selected.id, profile: result.profile }),
      }).then((r) => r.json());
      if (res.error) setError(res.error);
      else {
        setPublished(res.url);
        setDropped(res.dropped ?? []);
        setLeads((prev) => prev.filter((l) => l.id !== selected.id));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Deployed BD</h1>
      <p style={{ color: "#78716c", marginTop: 0 }}>
        {counts
          ? `${counts.queue} to research · ${counts.skipped} skipped · ${counts.done} done`
          : "Loading leads from Notion…"}
      </p>

      {error && (
        <div style={{ ...card, borderColor: "#dc2626", color: "#dc2626" }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 20 }}>
        <div>
          {leads.map((lead) => (
            <button
              key={lead.id}
              onClick={() => select(lead)}
              style={{
                ...card,
                width: "100%",
                textAlign: "left",
                cursor: "pointer",
                background: selected?.id === lead.id ? "#f5f5f4" : "#fff",
              }}
            >
              <strong>{lead.company || lead.name || "(untitled)"}</strong>
              <div style={{ color: "#78716c", fontSize: 13 }}>{lead.email}</div>
              <div style={{ color: "#a8a29e", fontSize: 12 }}>
                {lead.segment}
                {lead.language !== "en" && ` · ${lead.language}`}
              </div>
            </button>
          ))}
        </div>

        <div>
          {!selected && <div style={card}>Select a lead to build its profile.</div>}

          {selected && (
            <div style={card}>
              <h2 style={{ marginTop: 0 }}>
                {selected.company || selected.name || "(untitled)"}
              </h2>
              <Row label="Contact" value={selected.name} />
              <Row label="Email" value={selected.email} />
              <p style={{ whiteSpace: "pre-wrap", color: "#44403c" }}>
                {selected.message}
              </p>
              <button onClick={enrich} disabled={busy !== null} style={button}>
                {busy === "enrich" ? "Researching…" : "Research & score"}
              </button>
              {busy === "enrich" && (
                <span style={{ marginLeft: 10, color: "#78716c", fontSize: 13 }}>
                  Web research usually takes 1–3 minutes.
                </span>
              )}
            </div>
          )}

          {result && (
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>
                Score {result.profile.scores.total}/100 —{" "}
                {result.profile.recommendation}
              </h3>
              <Scores s={result.profile.scores} />
              <Row label="Website" value={result.profile.website} />
              <Row label="LinkedIn" value={result.profile.linkedin} />
              <Row label="Country" value={result.profile.country} />
              <Row label="Industry" value={result.profile.industry} />
              <Row label="AI relevance" value={result.profile.aiRelevance} />
              <Row label="Usage" value={result.profile.usageEstimate} />

              <p style={{ whiteSpace: "pre-wrap" }}>{result.profile.summary}</p>

              <h4>Contact</h4>
              <Row label="Name" value={result.profile.contact.name} />
              <Row label="Title" value={result.profile.contact.title} />
              <Row label="Seniority" value={result.profile.contact.seniority} />
              {result.profile.contact.isWrongContact && (
                <p style={{ color: "#b45309" }}>
                  Inbound contact looks wrong or too junior to decide.
                </p>
              )}

              <h4>
                Decision makers{" "}
                <span style={{ fontWeight: 400, color: "#78716c", fontSize: 13 }}>
                  confidence: {result.profile.dmConfidence}
                </span>
              </h4>
              {result.profile.decisionMakers.length === 0 ? (
                <p style={{ color: "#78716c" }}>None found.</p>
              ) : (
                <ul>
                  {result.profile.decisionMakers.map((d, i) => (
                    <li key={i}>
                      <strong>{d.name}</strong> — {d.title}
                      {d.linkedin && (
                        <>
                          {" "}
                          <a href={d.linkedin} target="_blank" rel="noreferrer">
                            LinkedIn
                          </a>
                        </>
                      )}
                      <div style={{ color: "#78716c", fontSize: 13 }}>
                        {d.evidence}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <p style={{ color: "#44403c" }}>
                {result.profile.recommendationRationale}
              </p>

              <details>
                <summary style={{ cursor: "pointer" }}>Raw research notes</summary>
                <pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
                  {result.findings}
                </pre>
              </details>

              <button onClick={publish} disabled={busy !== null} style={button}>
                {busy === "publish" ? "Writing…" : "Write to Notion"}
              </button>
              {published && (
                <a
                  href={published}
                  target="_blank"
                  rel="noreferrer"
                  style={{ marginLeft: 10 }}
                >
                  Open the created page
                </a>
              )}
              {dropped.length > 0 && (
                <div style={{ marginTop: 12, color: "#b45309", fontSize: 13 }}>
                  <strong>{dropped.length} field(s) not written</strong> — the
                  database schema has drifted from lib/config.ts:
                  <ul style={{ marginTop: 4 }}>
                    {dropped.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div style={{ fontSize: 14, marginBottom: 2 }}>
      <span style={{ color: "#78716c" }}>{label}: </span>
      {value}
    </div>
  );
}

function Scores({ s }: { s: Profile["scores"] }) {
  const rows: Array<[string, number]> = [
    ["Legit business", s.legitBusiness],
    ["Relevant AI", s.relevantAI],
    ["Contact seniority", s.contactSeniority],
    ["Usage potential", s.usagePotential],
  ];
  return (
    <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
      {rows.map(([label, v]) => (
        <div key={label} style={{ fontSize: 13 }}>
          <div style={{ color: "#78716c" }}>{label}</div>
          <div style={{ fontSize: 20 }}>{v}/25</div>
        </div>
      ))}
    </div>
  );
}

const card: React.CSSProperties = {
  border: "1px solid #e7e5e4",
  borderRadius: 8,
  padding: 16,
  marginBottom: 12,
  background: "#fff",
};

const button: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid #1c1917",
  background: "#1c1917",
  color: "#fff",
  cursor: "pointer",
};
