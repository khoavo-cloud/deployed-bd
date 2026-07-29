/**
 * Research and publish the whole queue, unattended.
 *
 *   npx tsx scripts/enrich-batch.ts --limit 5        # try five, then stop
 *   npx tsx scripts/enrich-batch.ts --dry-run        # research, print, write nothing
 *   npx tsx scripts/enrich-batch.ts                  # the rest of the queue
 *
 * Resumable by construction: the queue is whatever is not already in BD
 * Profiles, so re-running picks up where it stopped. A lead that fails is
 * deliberately *not* written as a Failed row — a row would make it look
 * processed and quietly exclude it from the retry.
 *
 * Writes only to BD Profiles. The inbound database is never modified.
 */

import { readFileSync } from "node:fs";

// tsx doesn't read .env.local on its own, and config.ts reads env at import time.
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const { listLeads, publishProfile } = await import("../lib/notion.js");
const { enrichLead } = await import("../lib/enrich.js");

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
};

const dryRun = flag("--dry-run");
const limit = Number(value("--limit") ?? Infinity);

const { queue, skipped, done } = await listLeads();
const batch = queue.slice(0, Number.isFinite(limit) ? limit : undefined);

console.log(
  `\n  queue ${queue.length} · skipped ${skipped.length} · already done ${done.length}`,
);
console.log(`  processing ${batch.length}${dryRun ? " (dry run — nothing will be written)" : ""}\n`);

let ok = 0;
const failures: Array<{ email: string; error: string }> = [];
const started = Date.now();

for (const [i, lead] of batch.entries()) {
  const tag = `[${i + 1}/${batch.length}] ${lead.email}`;
  const t = Date.now();

  try {
    const { profile } = await enrichLead(lead);
    const secs = ((Date.now() - t) / 1000).toFixed(0);

    const line =
      `${profile.companyName} · ${profile.scores.total}/100 · ${profile.recommendation}` +
      ` · ${profile.decisionMakers.length} DM (${profile.dmConfidence})` +
      ` · ${profile.evidenceUrls.length} cites`;

    if (dryRun) {
      console.log(`  ${tag}\n      ${line}  [${secs}s, not written]`);
      ok++;
      continue;
    }

    const { dropped } = await publishProfile(lead, profile);
    console.log(`  ${tag}\n      ${line}  [${secs}s]`);
    // A dropped field means Notion's schema no longer matches lib/config.ts.
    for (const d of dropped) console.log(`      ! dropped ${d}`);
    ok++;
  } catch (err: any) {
    const message = String(err.message ?? err).replace(/\s+/g, " ").slice(0, 160);
    console.log(`  ${tag}\n      FAILED: ${message}`);
    failures.push({ email: lead.email, error: message });
  }
}

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\n  ${ok} succeeded · ${failures.length} failed · ${mins} min`);

if (failures.length) {
  console.log("\n  Failures (still in the queue, just re-run to retry):");
  for (const f of failures) console.log(`    ${f.email} — ${f.error}`);
}
console.log();
