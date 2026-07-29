/**
 * Recompute Recommendation from Composite Score on rows already in BD Profiles.
 *
 *   npx tsx scripts/rederive-recommendation.ts --dry-run
 *   npx tsx scripts/rederive-recommendation.ts
 *
 * For rows written before the verdict was derived in code. Reads the score that
 * is already stored and rewrites only the label — no research, no API spend, and
 * every other property is left alone.
 */

import { readFileSync } from "node:fs";

for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const { notion } = await import("../lib/notion.js");
const { TARGET_DB_ID, TARGET_FIELDS } = await import("../lib/config.js");
const { recommendationFor } = await import("../lib/scoring.js");

const dryRun = process.argv.includes("--dry-run");

const rows: any[] = [];
let cursor: string | undefined;
do {
  const res: any = await notion.databases.query({
    database_id: TARGET_DB_ID,
    start_cursor: cursor,
    page_size: 100,
  });
  rows.push(...res.results);
  cursor = res.has_more ? res.next_cursor : undefined;
} while (cursor);

console.log(`\n  ${rows.length} rows${dryRun ? " (dry run — nothing will be written)" : ""}\n`);

let changed = 0;
for (const page of rows) {
  const score = page.properties[TARGET_FIELDS.score]?.number;
  if (score == null) continue;

  const current = page.properties[TARGET_FIELDS.recommendation]?.select?.name ?? "(none)";
  const derived = recommendationFor(score);
  if (current === derived) continue;

  const company =
    page.properties[TARGET_FIELDS.title]?.title?.map((t: any) => t.plain_text).join("") ?? "";
  console.log(`  ${String(score).padStart(3)}  ${current.padEnd(8)} -> ${derived.padEnd(8)}  ${company}`);
  changed++;

  if (!dryRun) {
    await notion.pages.update({
      page_id: page.id,
      properties: { [TARGET_FIELDS.recommendation]: { select: { name: derived } } } as any,
    });
  }
}

console.log(`\n  ${changed} row(s) ${dryRun ? "would change" : "updated"}, ${rows.length - changed} already correct\n`);
