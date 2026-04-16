// ingest-ais — Supabase Edge Function (v5)
// REDIRECTED to v2 pipeline: Pi sender stadig hertil.
// Vi normaliserer og kalder ingest_positions_v2.
// Ingen ændring på Pi nødvendig.
//
// Changes vs v4:
//   - Top-level try/catch wrapper (regel 1.2 i docs/EDGE-FUNCTION-RUNBOOK.md)
//     så uhåndterede exceptions propageres i HTTP body med stack.
//   - Fix: supabase-js rpc() returnerer PostgrestBuilder (PromiseLike),
//     ikke Promise — `.catch()` er undefined. ensure_partition-kald
//     er nu wrapped i try/catch. Samme bug som ramte ingest-positions v5/v6.
//
// Deno runtime.

import { createClient } from "npm:@supabase/supabase-js@2"

interface RawPosition {
  mmsi?: unknown; MMSI?: unknown
  lat?: unknown; latitude?: unknown; Latitude?: unknown
  lon?: unknown; longitude?: unknown; Longitude?: unknown; lng?: unknown
  speed?: unknown; sog?: unknown; SOG?: unknown
  course?: unknown; cog?: unknown; COG?: unknown
  heading?: unknown; HDG?: unknown; hdg?: unknown
  rot?: unknown; ROT?: unknown
  nav_status?: unknown; status?: unknown
  timestamp?: unknown; t?: unknown
  shipname?: unknown; vessel_name?: unknown; name?: unknown
  ship_type?: unknown; type_and_cargo?: unknown
  country?: unknown; imo?: unknown
}

interface NormalizedRow {
  mmsi: number
  lat: number
  lon: number
  t: number
  sog: number | null
  cog: number | null
  hdg: number | null
  vessel_name: string | null
}

const MAX_SPEED_MS = 30
const NULL_ISLAND_THRESHOLD = 0.001

function toNum(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return isNaN(n) ? null : n
}

function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function normalizeAndValidate(
  raw: RawPosition,
  prevByMmsi: Map<number, { lat: number; lon: number; t: number }>
): NormalizedRow | null {
  const mmsi = toNum(raw.mmsi ?? raw.MMSI)
  if (mmsi == null || mmsi < 100000000 || mmsi > 999999999) return null

  const lat = toNum(raw.lat ?? raw.latitude ?? raw.Latitude)
  const lon = toNum(raw.lon ?? raw.longitude ?? raw.Longitude ?? raw.lng)
  if (lat == null || lon == null) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  if (Math.abs(lat) < NULL_ISLAND_THRESHOLD && Math.abs(lon) < NULL_ISLAND_THRESHOLD) return null

  let t: number
  const rawT = raw.t ?? raw.timestamp
  if (rawT == null) {
    t = Date.now() / 1000
  } else if (typeof rawT === "string") {
    t = new Date(rawT).getTime() / 1000
  } else {
    const num = Number(rawT)
    t = num > 1e12 ? num / 1000 : num
  }

  const prev = prevByMmsi.get(mmsi)
  if (prev) {
    const dist = haversine(prev.lon, prev.lat, lon, lat)
    const dtSec = t - prev.t
    if (dtSec > 0 && dist / dtSec > MAX_SPEED_MS) return null
  }

  const sog = toNum(raw.speed ?? raw.sog ?? raw.SOG)
  const cog = toNum(raw.course ?? raw.cog ?? raw.COG)
  const hdg = toNum(raw.heading ?? raw.HDG ?? raw.hdg)
  const vessel_name = (raw.shipname ?? raw.vessel_name ?? raw.name ?? null) as string | null

  prevByMmsi.set(mmsi, { lat, lon, t })

  return { mmsi, lat, lon, t, sog, cog, hdg, vessel_name: vessel_name || null }
}

// ---------------------------------------------------------------------------
// Edge Function entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as Error
    console.error("[ingest-ais] FATAL:", err.message, err.stack)
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

  const rawRows: RawPosition[] = Array.isArray(body)
    ? body
    : Array.isArray((body as Record<string, unknown>).positions)
      ? (body as Record<string, unknown>).positions as RawPosition[]
      : []

  if (rawRows.length === 0) {
    return Response.json({ error: "No positions in payload" }, { status: 400 })
  }

  const prevByMmsi = new Map<number, { lat: number; lon: number; t: number }>()
  const valid: NormalizedRow[] = []
  let rejected = 0

  for (const raw of rawRows) {
    const row = normalizeAndValidate(raw, prevByMmsi)
    if (row) {
      valid.push(row)
    } else {
      rejected++
    }
  }

  if (valid.length === 0) {
    return Response.json({ accepted: 0, rejected, source: sourceName })
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  )

  // Ensure partition for today and tomorrow (cheap idempotent call).
  // NOTE: supabase-js rpc() returns a PostgrestBuilder (PromiseLike), NOT a Promise,
  // so `.catch()` does not exist on it. Must wrap in try/catch instead.
  const today = new Date()
  const tomorrow = new Date(today.getTime() + 86400000)
  try { await supabase.rpc("ensure_partition", { p_date: today.toISOString().slice(0, 10) }) } catch { /* idempotent */ }
  try { await supabase.rpc("ensure_partition", { p_date: tomorrow.toISOString().slice(0, 10) }) } catch { /* idempotent */ }

  const rpcRows = valid.map(row => ({
    mmsi: row.mmsi,
    lat: row.lat,
    lon: row.lon,
    t: row.t,
    sog: row.sog,
    cog: row.cog,
    hdg: row.hdg,
    vessel_name: row.vessel_name,
  }))

  const { data: rpcResult, error: rpcError } = await supabase.rpc("ingest_positions_v2", {
    p_rows: rpcRows,
    p_source_name: sourceName,
  })

  if (rpcError) {
    console.error("[ingest-ais→v2] RPC error:", rpcError.message)
    return Response.json({ error: "Storage failed", detail: rpcError.message }, { status: 500 })
  }

  const result = rpcResult as { accepted?: number; rejected?: number; error?: string } | null

  if (result?.error) {
    return Response.json({ error: result.error }, { status: 400 })
  }

  const totalAccepted = result?.accepted ?? valid.length
  const totalRejected = rejected + (result?.rejected ?? 0)

  console.log(
    `[ingest-ais→v2] source=${sourceName} batch=${rawRows.length}`,
    `accepted=${totalAccepted} rejected=${totalRejected}`
  )

  return new Response(JSON.stringify({
    accepted: totalAccepted,
    rejected: totalRejected,
    source: sourceName,
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  })
}
