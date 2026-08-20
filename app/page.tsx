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

  // Where the queue came from. File leads have no Notion page, so requests must
  // carry the whole lead rather than an id the server can look up.
  const [source, setSource] = useState<"notion" | "file">("notion");
  const [intake, setIntake] = useState<{
    name: string;
    mapping: Record<string, string | undefined>;
    method: "ai" | "keywords";
    unusable: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  // Narrow the queue before spending anything. A 541-row event export is mostly
  // consumer addresses, and the business-domain subset is where the value is.
  const [filter, setFilter] = useState({
    segment: "all",
    language: "all",
    withCompany: false,
    q: "",
  });

  const [bulk, setBulk] = useState<{
    total: number;
    done: number;
    current: string;
    log: string[];
    stopping: boolean;
  } | null>(null);

  function loadNotion() {
    setLoading(true);
    fetch("/api/leads")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setError(d.error);
        setLeads(d.leads);
        setCounts(d.counts);
        setIntake(null);
        setSource("notion");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(loadNotion, []);

  async function upload(file: File) {
    setLoading(true);
    setError(null);
    setSelected(null);
    setResult(null);
    setBulk(null);
    setTicked(new Set());
    try {
      const body = new FormData();
      body.append("file", file);
      const d = await fetch("/api/intake", { method: "POST", body }).then((r) => r.json());
      if (d.error) {
        setError(d.error);
        return;
      }
      setLeads(d.leads);
      setCounts(d.counts);
      setIntake({
        name: d.sourceName,
        mapping: d.mapping,
        method: d.method,
        unusable: d.counts.unusable,
      });
      setSource("file");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  /**
   * How to refer to a lead when calling the API. Notion leads are re-read
   * server-side from their id; file leads only exist in this browser session.
   */
  const ref = (l: Lead) => (l.id.startsWith("file:") ? { lead: l } : { leadId: l.id });

  function select(lead: Lead) {
    setSelected(lead);
    setResult(null);
    setError(null);
    setPublished(null);
  }

  /**
   * Research a lead and write the profile straight to Notion.
   *
   * There is no approve step: triage happens in the Notion views, which is
   * where the queue is actually worked. If the publish fails the profile stays
   * on screen with a retry button rather than being discarded — the research is
   * already paid for and re-running it would cost again.
   */
  async function enrich() {
    if (!selected) return;
    const lead = selected;
    setBusy("enrich");
    setError(null);
    try {
      const res = await fetch("/api/enrich", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ref(lead)),
      }).then((r) => r.json());
      if (res.error) {
        setError(res.error);
        return;
      }
      setResult({ profile: res.profile, findings: res.findings });

      setBusy("publish");
      const pub = await fetch("/api/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...ref(lead), profile: res.profile }),
      }).then((r) => r.json());
      if (pub.error) {
        setError(`Researched, but the write to Notion failed: ${pub.error}`);
        return;
      }
      setPublished(pub.url);
      setDropped(pub.dropped ?? []);
      setLeads((prev) => prev.filter((l) => l.id !== lead.id));
      setCounts((c) => (c ? { ...c, queue: c.queue - 1, done: c.done + 1 } : c));
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
        body: JSON.stringify({ ...ref(selected), profile: result.profile }),
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
   */
  async function runBulk() {
    const queue = leads.filter((l) => ticked.has(l.id));
    if (!queue.length) return;

    const minutes = Math.ceil((queue.length * 45) / 60);
    const ok = window.confirm(
      `Research and publish ${queue.length} lead${queue.length === 1 ? "" : "s"}?\n\n` +
        `· Takes roughly ${minutes} minute${minutes === 1 ? "" : "s"} — keep this tab open\n` +
        `· Each lead costs a Gemini research call\n` +
        `· Each profile is written to Notion as it finishes\n\n` +
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
          body: JSON.stringify(ref(lead)),
        }).then((r) => r.json());
        if (e.error) throw new Error(e.error);

        const p = await fetch("/api/publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...ref(lead), profile: e.profile }),
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

  const visible = leads.filter((l) => {
    if (filter.segment !== "all" && l.segment !== filter.segment) return false;
    if (filter.language !== "all" && l.language !== filter.language) return false;
    if (filter.withCompany && !l.company.trim()) return false;
    if (filter.q) {
      const q = filter.q.toLowerCase();
      const hay = `${l.email} ${l.company} ${l.name} ${l.jobTitle}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  /**
   * Changing a filter clears the selection.
   *
   * Otherwise leads ticked under one filter stay ticked once hidden, and Run
   * would research rows the operator can no longer see — an expensive surprise.
   */
  function changeFilter(patch: Partial<typeof filter>) {
    setFilter((f) => ({ ...f, ...patch }));
    setTicked(new Set());
  }

  const languages = [...new Set(leads.map((l) => l.language))].sort();
  const segments = [...new Set(leads.map((l) => l.segment))].sort();

  return (
    <div>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Deployed BD</h1>
      <p style={{ color: "#78716c", marginTop: 0 }}>
        {loading
          ? "Loading…"
          : counts
            ? `${counts.queue} to research · ${counts.skipped} skipped · ${counts.done} already in Notion`
            : "…"}
      </p>

      <div style={{ ...card, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>Intake</strong>

        <button
          onClick={loadNotion}
          disabled={running || loading}
          style={source === "notion" ? tab.on : tab.off}
        >
          Notion — Custom: Web Leads
        </button>

        <label style={{ ...(source === "file" ? tab.on : tab.off), cursor: "pointer" }}>
          Upload CSV or XLSX
          <input
            type="file"
            accept=".csv,.xlsx,text/csv"
            disabled={running || loading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = "";
            }}
            style={{ display: "none" }}
          />
        </label>

        {intake && (
          <span style={{ fontSize: 13, color: "#78716c" }}>
            {intake.name}
            {intake.unusable > 0 && ` · ${intake.unusable} row(s) had no email`}
          </span>
        )}
      </div>

      {intake && (
        <div style={{ ...card, fontSize: 13, color: "#78716c" }}>
          Columns read ({intake.method === "ai" ? "matched by AI" : "matched by header keywords"}) —{" "}
          {Object.entries(intake.mapping)
            .filter(([, v]) => v)
            .map(([k, v]) => `${k}: "${v}"`)
            .join(" · ") || "none"}
          . Profiles are still written to Notion BD Profiles.
        </div>
      )}

      {error && (
        <div style={{ ...card, borderColor: "#dc2626", color: "#dc2626" }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 20 }}>
        <div>
          {leads.length > 0 && (
            <div style={{ ...card, padding: 10, display: "grid", gap: 6 }}>
              <input
                placeholder="Filter by email, company, name…"
                value={filter.q}
                onChange={(e) => changeFilter({ q: e.target.value })}
                disabled={running}
                style={{
                  padding: "5px 8px", fontSize: 13, borderRadius: 6,
                  border: "1px solid #e7e5e4", width: "100%", boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <select
                  value={filter.segment}
                  onChange={(e) => changeFilter({ segment: e.target.value })}
                  disabled={running}
                  style={dropdown}
                >
                  <option value="all">All segments</option>
                  {segments.map((s) => (
                    <option key={s} value={s}>
                      {s} ({leads.filter((l) => l.segment === s).length})
                    </option>
                  ))}
                </select>
                {languages.length > 1 && (
                  <select
                    value={filter.language}
                    onChange={(e) => changeFilter({ language: e.target.value })}
                    disabled={running}
                    style={dropdown}
                  >
                    <option value="all">All languages</option>
                    {languages.map((l) => (
                      <option key={l} value={l}>
                        {l} ({leads.filter((x) => x.language === l).length})
                      </option>
                    ))}
                  </select>
                )}
                <label style={{ fontSize: 13, color: "#78716c", display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={filter.withCompany}
                    onChange={(e) => changeFilter({ withCompany: e.target.checked })}
                    disabled={running}
                  />
                  has company
                </label>
              </div>
            </div>
          )}

          {leads.length > 0 && (
            <div style={{ ...card, padding: 10, display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={ticked.size > 0 && ticked.size === visible.length}
                onChange={(e) =>
                  setTicked(e.target.checked ? new Set(visible.map((l) => l.id)) : new Set())
                }
                disabled={running || visible.length === 0}
              />
              <span style={{ fontSize: 13, color: "#78716c", flex: 1 }}>
                {ticked.size
                  ? `${ticked.size} selected`
                  : `Select all ${visible.length}`}
                {visible.length !== leads.length && ` · ${leads.length - visible.length} hidden`}
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

          {visible.map((lead) => (
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
                {busy === "enrich"
                  ? "Researching…"
                  : busy === "publish"
                    ? "Writing to Notion…"
                    : "Research & publish"}
              </button>
              {busy === "enrich" && (
                <span style={{ marginLeft: 10, color: "#78716c", fontSize: 13 }}>
                  Web research usually takes 30–90 seconds, then it writes to Notion.
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

              {published ? (
                <a href={published} target="_blank" rel="noreferrer">
                  ✓ Written to Notion — open the profile
                </a>
              ) : (
                // Only reachable when the automatic write failed; the research
                // is already paid for, so offer a retry rather than losing it.
                <button onClick={publish} disabled={busy !== null} style={button}>
                  {busy === "publish" ? "Writing…" : "Retry write to Notion"}
                </button>
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

const dropdown: React.CSSProperties = {
  padding: "4px 6px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid #e7e5e4",
  background: "#fff",
};

const tabBase: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  fontSize: 13,
  border: "1px solid #e7e5e4",
  background: "#fff",
  color: "#44403c",
  cursor: "pointer",
};

const tab = {
  on: { ...tabBase, borderColor: "#1c1917", background: "#1c1917", color: "#fff" },
  off: tabBase,
};

const button: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid #1c1917",
  background: "#1c1917",
  color: "#fff",
  cursor: "pointer",
};
