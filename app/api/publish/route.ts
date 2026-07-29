import { NextResponse } from "next/server";
import { getLead, publishProfile } from "../../../lib/notion";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { leadId, profile } = await req.json();
    if (!leadId || !profile) {
      return NextResponse.json(
        { error: "leadId and profile are required" },
        { status: 400 },
      );
    }
    const lead = await getLead(leadId);
    const { page, dropped } = await publishProfile(lead, profile);
    // Surfaced rather than swallowed: a dropped field means schema drift.
    return NextResponse.json({ ok: true, url: page.url, dropped });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
