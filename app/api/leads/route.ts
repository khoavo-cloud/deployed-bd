import { NextResponse } from "next/server";
import { listLeads } from "../../../lib/notion";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { queue, skipped, done } = await listLeads();
    return NextResponse.json({
      leads: queue,
      skipped,
      counts: { queue: queue.length, skipped: skipped.length, done: done.length },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
