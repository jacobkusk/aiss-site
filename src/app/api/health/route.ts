import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const revalidate = 0;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET() {
  const { data, error } = await supabase.rpc("get_ingest_health");

  if (error) {
    return NextResponse.json(
      { status: "error", error: error.message },
      { status: 503 }
    );
  }

  const health = data as {
    last_ingest:          { ts: string; accepted: number; rejected: number } | null;
    positions_last_5min:  number;
    positions_last_hour:  number;
    active_vessels_30min: number;
  };

  // Derive status from last ingest age
  const lastTs   = health.last_ingest?.ts ? new Date(health.last_ingest.ts) : null;
  const ageMs    = lastTs ? Date.now() - lastTs.getTime() : Infinity;
  const ageSec   = Math.round(ageMs / 1000);
  const status   = ageMs < 5 * 60 * 1000  ? "ok"
                 : ageMs < 30 * 60 * 1000 ? "stale"
                 : "down";

  const body = {
    status,
    last_ingest_ago_sec:  ageSec,
    last_ingest_at:       health.last_ingest?.ts ?? null,
    last_batch_accepted:  health.last_ingest?.accepted ?? 0,
    last_batch_rejected:  health.last_ingest?.rejected ?? 0,
    positions_last_5min:  health.positions_last_5min,
    positions_last_hour:  health.positions_last_hour,
    active_vessels_30min: health.active_vessels_30min,
  };

  return NextResponse.json(body, { status: status === "down" ? 503 : 200 });
}
