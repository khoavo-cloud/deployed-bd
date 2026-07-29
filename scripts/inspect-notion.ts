/**
 * Prints the real property names and types of both Notion databases so you can
 * fill in lib/config.ts correctly.
 *
 *   npm run inspect:notion
 */
import { Client } from "@notionhq/client";

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: "2022-06-28",
});

async function show(label: string, id: string | undefined) {
  if (!id) {
    console.log(`\n${label}: not set — skipping\n`);
    return;
  }
  const db: any = await notion.databases.retrieve({ database_id: id });
  const title = db.title?.map((t: any) => t.plain_text).join("") || "(untitled)";
  console.log(`\n=== ${label}: ${title} ===`);
  for (const [name, prop] of Object.entries<any>(db.properties)) {
    const options =
      prop.type === "select" || prop.type === "multi_select"
        ? ` [${prop[prop.type].options.map((o: any) => o.name).join(", ")}]`
        : "";
    console.log(`  ${JSON.stringify(name).padEnd(28)} ${prop.type}${options}`);
  }
}

await show("SOURCE (inbound leads)", process.env.NOTION_SOURCE_DB_ID);
await show("TARGET (scored profiles)", process.env.NOTION_TARGET_DB_ID);
