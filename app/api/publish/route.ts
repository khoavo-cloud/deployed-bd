import { NextResponse } from "next/server";
import { getLead, publishProfile } from "../../../lib/notion";
import type { Lead } from "../../../lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { leadId, lead: bodyLead, profile } = await req.json();
    if (!profile || (!leadId && !bodyLead)) {
      return NextResponse.json(
        { error: "profile and either leadId or lead are required" },
        { status: 400 },
      );
    }
    // Notion leads are re-read server-side; file leads arrive whole.
    const lead: Lead = leadId ? await getLead(leadId) : bodyLead;
    const { page, dropped } = await publishProfile(lead, profile);
    // Surfaced rather than swallowed: a dropped field means schema drift.
    return NextResponse.json({ ok: true, url: page.url, dropped });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
