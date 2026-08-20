import { NextResponse } from "next/server";
import { readIntakeFile } from "../../../lib/intake";
import { publishedEmails } from "../../../lib/notion";

export const dynamic = "force-dynamic";

/**
 * Parse an uploaded CSV or XLSX into the same lead queue the Notion reader
 * returns. Leads whose email is already in BD Profiles are separated out, so
 * re-uploading a file that overlaps a previous one doesn't pay for the same
 * research twice.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
    }

    const parsed = await readIntakeFile(file.name, await file.arrayBuffer());

    const published = await publishedEmails();
    const queue = parsed.queue.filter((l) => !published.has(l.email));
    const done = parsed.queue.length - queue.length;

    return NextResponse.json({
      leads: queue,
      skipped: parsed.skipped,
      mapping: parsed.mapping,
      sourceName: parsed.sourceName,
      counts: {
        queue: queue.length,
        skipped: parsed.skipped.length,
        done,
        unusable: parsed.unusable,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
