import { NextResponse } from "next/server";
import { getLead } from "../../../lib/notion";
import { enrichLead } from "../../../lib/enrich";
import type { Lead } from "../../../lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Accepts either `leadId` (the lead lives in Notion and is re-read here, so the
 * client can't tamper with what gets researched) or a whole `lead` object,
 * which is how file intake works — those leads have no Notion page behind them.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const lead: Lead | null = body.leadId
      ? await getLead(body.leadId)
      : (body.lead ?? null);

    if (!lead?.email) {
      return NextResponse.json(
        { error: "Provide either leadId or a lead with an email." },
        { status: 400 },
      );
    }

    const { profile, findings } = await enrichLead(lead);
    return NextResponse.json({ lead, profile, findings });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
