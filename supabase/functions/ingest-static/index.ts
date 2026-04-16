// ingest-static — Supabase Edge Function (v1)
// Batched write path for AIS Type 5 / Type 19 / Type 24 static+voyage data
// from the PI collector. Anon callers hit this endpoint; the edge internally
// uses service_role to call upsert_vessel_static (which is REVOKEd from anon).
//
// Rationale:
//   The PI uses the anon key. upsert_vessel_static RPC is service_role only
//   (writing to entities is a privileged operation). This edge bridges the
//   two — same pattern as ingest-positions → ingest_positions_v2.
//
// Contract:
//   POST /functions/v1/ingest-static
//   Headers: apikey=<anon>, x-source=<ingest_source>
//   Body: { "static": [ { mmsi, ship_type?, callsign?, imo?, destination?, shipname? } ] }
//
//   Response 200: {
//     accepted: n,       // RPC returned a non-null entity_id
//     rejected: n,       // sum of reasons below
//     reject_reasons: { mmsi_invalid, empty_payload, rpc_error },
//     source: "pi4_rtlsdr"
//   }
//
// Rules (see CLAUDE.md §Edge Function rules):
//   1. No .catch() on supabase-js chains — wrap in try/catch.
//   2. Top-level try/catch; 500 body carries { error, message, stack }.
//   3. Per-reason counters from day one.
//   4. Smoke-test via pg_net after deploy.
//
// Deno runtime.

import { createClient } from "npm:@supabase/supabase-js@2"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawStatic {
  mmsi?: unknown; MMSI?: unknown
  ship_type?: unknown
  callsign?: unknown
  imo?: unknown
  destination?: unknown
  shipname?: unknown; vessel_name?: unknown; name?: unknown
}

interface NormalizedStatic {
  mmsi: number
  ship_type: number | null
  callsign: string | null
  imo: number | null
  destination: string | null
  shipname: string | null
}

type RejectReason = "mmsi_invalid" | "empty_payload" | "rpc_error"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNum(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null
  const n = typeof x === "number" ? x : Number(x)
  return Number.isFinite(n) ? n : null
}

function toStr(x: unknown): string | null {
  if (x === null || x === undefined) return null
  const s = String(x).trim().replace(/@+$/, "").trim()
  return s.length > 0 ? s : null
}

function normalize(raw: RawStatic): NormalizedStatic | null {
  const mmsiRaw = toNum(raw.mmsi ?? raw.MMSI)
  if (mmsiRaw === null) return null
  const mmsi = Math.trunc(mmsiRaw)
  if (mmsi < 1 || mmsi > 999_999_999) return null

  const shipTypeRaw = toNum(raw.ship_type)
  const imoRaw = toNum(raw.imo)

  return {
    mmsi,
    // AIS: ship_type 0 = "not available" → drop. Range 1..99 valid.
    ship_type: shipTypeRaw !== null && shipTypeRaw >= 1 && shipTypeRaw <= 99
      ? Math.trunc(shipTypeRaw)
      : null,
    callsign: toStr(raw.callsign),
    // AIS: imo 0 = "unknown" → drop.
    imo: imoRaw !== null && imoRaw > 0 ? Math.trunc(imoRaw) : null,
    destination: toStr(raw.destination),
    shipname: toStr(raw.shipname ?? raw.vessel_name ?? raw.name),
  }
}

function hasAnyField(n: NormalizedStatic): boolean {
  return n.ship_type !== null ||
         n.callsign !== null ||
         n.imo !== null ||
         n.destination !== null ||
         n.shipname !== null
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as Error
    console.error("[ingest-static] FATAL:", err.message, err.stack)
    return new Response(JSON.stringify({
      error: "unhandled",
      message: err.message,
      stack: err.stack?.split("\n").slice(0, 8),
    }), { status: 500, headers: { "Content-Type": "application/json" } })
  }
})

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key, x-source",
      },
    })
  }

  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 })
  }

  const apiKey = req.headers.get("x-api-key") ?? req.headers.get("apikey")
  const expectedKey = Deno.env.get("INGEST_API_KEY")
  if (expectedKey && apiKey !== expectedKey) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const sourceName = req.headers.get("x-source") ?? "pi4_rtlsdr"

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const rawRows: RawStatic[] = Array.isArray(body)
    ? body
    : Array.isArray((body as Record<string, unknown>).static)
      ? (body as Record<string, unknown>).static as RawStatic[]
      : []

  const reasons: Record<RejectReason, number> = {
    mmsi_invalid: 0,
    empty_payload: 0,
    rpc_error: 0,
  }

  if (rawRows.length === 0) {
    return Response.json({ error: "No static rows in payload" }, { status: 400 })
  }

  // Normalise + dedupe within batch (same MMSI appearing twice → use last).
  const byMmsi = new Map<number, NormalizedStatic>()
  for (const raw of rawRows) {
    const norm = normalize(raw)
    if (norm === null) { reasons.mmsi_invalid++; continue }
    if (!hasAnyField(norm)) { reasons.empty_payload++; continue }
    byMmsi.set(norm.mmsi, norm)
  }

  const toUpsert = Array.from(byMmsi.values())

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  )

  let accepted = 0
  // Serial loop — Type 5 batches from PI are small (typically <20 rows per
  // 5s flush). Keeps error handling per-row trivial and avoids N concurrent
  // RPC calls that'd race on the partial unique index under ON CONFLICT.
  for (const row of toUpsert) {
    try {
      const { data, error } = await supabase.rpc("upsert_vessel_static", {
        p_mmsi: row.mmsi,
        p_ship_type: row.ship_type,
        p_callsign: row.callsign,
        p_imo: row.imo,
        p_destination: row.destination,
        p_shipname: row.shipname,
      })
      if (error) {
        reasons.rpc_error++
        console.error(`[ingest-static] rpc error mmsi=${row.mmsi}:`, error.message)
      } else if (data) {
        accepted++
      } else {
        // RPC returned null (mmsi rejected by plpgsql guard)
        reasons.rpc_error++
      }
    } catch (e) {
      reasons.rpc_error++
      console.error(`[ingest-static] rpc exception mmsi=${row.mmsi}:`, (e as Error).message)
    }
  }

  const rejected = reasons.mmsi_invalid + reasons.empty_payload + reasons.rpc_error

  console.log(
    `[ingest-static] source=${sourceName} batch=${rawRows.length} ` +
    `accepted=${accepted} rejected=${rejected} reasons=${JSON.stringify(reasons)}`
  )

  return Response.json({
    accepted,
    rejected,
    reject_reasons: reasons,
    source: sourceName,
  })
}
