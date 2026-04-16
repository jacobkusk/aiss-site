// health — Supabase Edge Function (v3)
// Public read-only heartbeat: "is the ingest pipeline flowing?"
//
// Changes vs v2:
//   - Top-level try/catch wrapper per docs/EDGE-FUNCTION-RUNBOOK.md §1.2.
//     Unhandled exceptions now propagate in HTTP body with stack so
//     diagnostic tools (pg_net.http_post) can see them even when the
//     Supabase logs panel shows only request summaries.
//
// Deno runtime.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

Deno.serve(async (req: Request) => {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as Error
    console.error("[health] FATAL:", err.message, err.stack)
    return new Response(JSON.stringify({
      error: "unhandled",
      message: err.message,
      stack: err.stack?.split("\n").slice(0, 8),
    }), { status: 500, headers: { "Content-Type": "application/json" } })
  }
})

async function handle(_req: Request): Promise<Response> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  )

  const { data, error } = await supabase.rpc("get_ingest_health")

  if (error) {
    return new Response(JSON.stringify({ status: "error", error: error.message }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })
  }

  const health = data as {
    last_ingest: { ts: string; accepted: number; rejected: number } | null
    positions_last_5min: number
    positions_last_hour: number
    active_vessels_30min: number
  }

  const lastTs = health.last_ingest?.ts ? new Date(health.last_ingest.ts) : null
  const ageMs  = lastTs ? Date.now() - lastTs.getTime() : Infinity
  const ageSec = Math.round(ageMs / 1000)
  const status = ageMs < 5 * 60 * 1000  ? "ok"
               : ageMs < 30 * 60 * 1000 ? "stale"
               : "down"

  const body = {
    status,
    last_ingest_ago_sec:  ageSec,
    last_ingest_at:       health.last_ingest?.ts ?? null,
    last_batch_accepted:  health.last_ingest?.accepted ?? 0,
    last_batch_rejected:  health.last_ingest?.rejected ?? 0,
    positions_last_5min:  health.positions_last_5min,
    positions_last_hour:  health.positions_last_hour,
    active_vessels_30min: health.active_vessels_30min,
  }

  return new Response(JSON.stringify(body), {
    status: status === "down" ? 503 : 200,
    headers: { "Content-Type": "application/json" },
  })
}
