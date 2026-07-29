import { NextResponse } from "next/server";
import { getLead } from "../../../lib/notion";
import { enrichLead } from "../../../lib/enrich";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const { leadId } = await req.json();
    if (!leadId) {
      return NextResponse.json({ error: "leadId is required" }, { status: 400 });
    }
    const lead = await getLead(leadId);
    const { profile, findings } = await enrichLead(lead);
    return NextResponse.json({ lead, profile, findings });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
