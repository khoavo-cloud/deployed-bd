/**
 * Lists every database this integration can see, with its id and full schema.
 *
 *   npx tsx scripts/discover-notion.ts
 *
 * Use this when you don't know the database ids yet, or to check that both
 * databases have actually been shared with the integration — a database that
 * isn't shared simply won't appear here, which is the usual cause of a 404
 * from an otherwise valid token.
 */

import { Client } from "@notionhq/client";
import { readFileSync } from "node:fs";

// tsx doesn't read .env.local on its own, and this script has to run before
// lib/config.ts is filled in, so load it here rather than importing config.
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: "2022-06-28",
});

const results: any[] = [];
let cursor: string | undefined;
do {
  const res: any = await notion.search({
    filter: { property: "object", value: "database" },
    start_cursor: cursor,
    page_size: 100,
  });
  results.push(...res.results);
  cursor = res.has_more ? res.next_cursor : undefined;
} while (cursor);

if (!results.length) {
  console.log(
    "\n  No databases visible.\n" +
    "  Open each database in Notion → ••• → Connections → add your integration.\n",
  );
  process.exit(0);
}

console.log(`\n  ${results.length} database(s) shared with this integration\n`);

for (const db of results) {
  const title = db.title?.map((t: any) => t.plain_text).join("") || "(untitled)";
  const props = Object.entries<any>(db.properties);

  console.log(`\n=== ${title} ===`);
  console.log(`  id:  ${db.id.replace(/-/g, "")}`);
  console.log(`  url: ${db.url}`);
  console.log(`  ${props.length} properties:`);

  for (const [name, prop] of props) {
    const options =
      prop.type === "select" || prop.type === "multi_select"
        ? `  [${prop[prop.type].options.map((o: any) => o.name).join(", ")}]`
        : "";
    console.log(`    ${JSON.stringify(name).padEnd(30)} ${prop.type}${options}`);
  }
}
console.log();
