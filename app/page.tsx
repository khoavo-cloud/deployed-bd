"use client";

import { useEffect, useRef, useState } from "react";
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

  // Bulk run: ticked leads plus live progress. The stop flag is a ref, not
  // state — the loop needs to read it synchronously between leads, and stale
  // state inside a running async loop would let it keep spending after Stop.
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const stopRef = useRef(false);
  const [bulk, setBulk] = useState<{
    total: number;
    done: number;
    current: string;
    log: string[];
    stopping: boolean;
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

  function toggle(id: string) {
    setTicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  /**
   * Research and publish every ticked lead, one at a time.
   *
   * Each lead is a separate pair of requests rather than one long server call,
   * so nothing runs against the function timeout however many are selected.
   * Unlike the single-lead flow there is no review step — bulk publishes what it
   * finds — so the confirmation states that plainly before anything is spent.
   */
  async function runBulk() {
    const queue = leads.filter((l) => ticked.has(l.id));
    if (!queue.length) return;

    const minutes = Math.ceil((queue.length * 45) / 60);
    const ok = window.confirm(
      `Research and publish ${queue.length} lead${queue.length === 1 ? "" : "s"}?\n\n` +
        `· Takes roughly ${minutes} minute${minutes === 1 ? "" : "s"} — keep this tab open\n` +
        `· Each lead costs a Gemini research call\n` +
        `· Profiles are written to Notion automatically, without review\n\n` +
        `You can stop between leads.`,
    );
    if (!ok) return;

    setError(null);
    setSelected(null);
    setResult(null);
    stopRef.current = false;
    let done = 0;
    const log: string[] = [];
    setBulk({ total: queue.length, done, current: "", log, stopping: false });

    for (const lead of queue) {
      if (stopRef.current) break;
      setBulk((b) => (b ? { ...b, current: lead.email } : b));

      try {
        const e = await fetch("/api/enrich", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ leadId: lead.id }),
        }).then((r) => r.json());
        if (e.error) throw new Error(e.error);

        const p = await fetch("/api/publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ leadId: lead.id, profile: e.profile }),
        }).then((r) => r.json());
        if (p.error) throw new Error(p.error);

        log.unshift(
          `${e.profile.companyName} — ${e.profile.scores.total}/100 ${e.profile.recommendation}`,
        );
        setLeads((prev) => prev.filter((l) => l.id !== lead.id));
        setTicked((prev) => {
          const next = new Set(prev);
          next.delete(lead.id);
          return next;
        });
      } catch (err: any) {
        // Left in the queue on purpose — a failed lead should be retryable.
        log.unshift(`${lead.email} — FAILED: ${String(err.message).slice(0, 80)}`);
      }

      done++;
      setBulk((b) => (b ? { ...b, done, log: [...log] } : b));
    }

    setBulk((b) => (b ? { ...b, current: "" } : b));
    setCounts((c) => (c ? { ...c, queue: c.queue - done, done: c.done + done } : c));
  }

  const running = bulk !== null && bulk.done < bulk.total && !bulk.stopping;

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
          {leads.length > 0 && (
            <div style={{ ...card, padding: 10, display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={ticked.size === leads.length && leads.length > 0}
                onChange={(e) =>
                  setTicked(e.target.checked ? new Set(leads.map((l) => l.id)) : new Set())
                }
                disabled={running}
              />
              <span style={{ fontSize: 13, color: "#78716c", flex: 1 }}>
                {ticked.size ? `${ticked.size} selected` : "Select all"}
              </span>
              <button
                onClick={runBulk}
                disabled={running || ticked.size === 0}
                style={{
                  ...button,
                  padding: "5px 10px",
                  fontSize: 13,
                  opacity: running || ticked.size === 0 ? 0.4 : 1,
                }}
              >
                Run {ticked.size || ""}
              </button>
            </div>
          )}

          {leads.map((lead) => (
            <div
              key={lead.id}
              style={{
                ...card,
                display: "flex",
                gap: 8,
                cursor: running ? "default" : "pointer",
                background: selected?.id === lead.id ? "#f5f5f4" : "#fff",
              }}
            >
              <input
                type="checkbox"
                checked={ticked.has(lead.id)}
                onChange={() => toggle(lead.id)}
                disabled={running}
                style={{ marginTop: 3 }}
              />
              <div
                onClick={() => !running && select(lead)}
                style={{ flex: 1, minWidth: 0 }}
              >
                <strong>{lead.company || lead.name || "(untitled)"}</strong>
                <div style={{ color: "#78716c", fontSize: 13 }}>{lead.email}</div>
                <div style={{ color: "#a8a29e", fontSize: 12 }}>
                  {lead.segment}
                  {lead.language !== "en" && ` · ${lead.language}`}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div>
          {bulk && (
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>
                {running
                  ? `Researching ${bulk.done + 1} of ${bulk.total}…`
                  : `Finished — ${bulk.done} of ${bulk.total} processed`}
              </h3>
              {running && (
                <>
                  <p style={{ color: "#78716c", fontSize: 13 }}>
                    {bulk.current} · keep this tab open
                  </p>
                  <button
                    onClick={() => {
                      stopRef.current = true;
                      setBulk((b) => (b ? { ...b, stopping: true } : b));
                    }}
                    style={{ ...button, background: "#fff", color: "#1c1917" }}
                  >
                    Stop after this lead
                  </button>
                </>
              )}
              <ul style={{ fontSize: 13, paddingLeft: 18 }}>
                {bulk.log.map((line, i) => (
                  <li key={i} style={{ color: line.includes("FAILED") ? "#b45309" : "#44403c" }}>
                    {line}
                  </li>
                ))}
              </ul>
              {!running && (
                <p style={{ fontSize: 13, color: "#78716c" }}>
                  Profiles are in Notion. Anything that failed is still in the queue — run it again.
                </p>
              )}
            </div>
          )}

          {!selected && !bulk && leads.length > 0 && (
            <div style={card}>Select a lead to build its profile, or tick several and press Run.</div>
          )}

          {!selected && !bulk && leads.length === 0 && counts && (
            <div style={card}>
              <strong>Queue is empty.</strong>
              <p style={{ color: "#78716c", marginBottom: 0 }}>
                All {counts.done} researched leads are in Notion, and {counts.skipped} were
                skipped as unresearchable. New form submissions appear here — reload to check.
              </p>
            </div>
          )}

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
