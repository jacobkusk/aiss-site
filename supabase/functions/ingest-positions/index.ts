// ingest-positions — Supabase Edge Function (v2)
// Append-only ingest. No buffer, no flush, no smart filtering.
// Normalise → validate → INSERT positions_v2 + UPSERT entity_last via ingest_positions_v2 RPC.
// Deno runtime.

import { createClient } from "npm:@supabase/supabase-js@2"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  t: number           // unix epoch SECONDS
  sog: number | null   // knots (original)
  cog: number | null
  hdg: number | null
  vessel_name: string | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SPEED_MS = 30              // ~58 knots — hard reject
const NULL_ISLAND_THRESHOLD = 0.001

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Normalise + validate
// ---------------------------------------------------------------------------

function normalizeAndValidate(
  raw: RawPosition,
  prevByMmsi: Map<number, { lat: number; lon: number; t: number }>
): NormalizedRow | null {
  // --- Extract with multiple naming conventions ---
  const mmsi = toNum(raw.mmsi ?? raw.MMSI)
  if (mmsi == null || mmsi < 100000000 || mmsi > 999999999) return null

  const lat = toNum(raw.lat ?? raw.latitude ?? raw.Latitude)
  const lon = toNum(raw.lon ?? raw.longitude ?? raw.Longitude ?? raw.lng)
  if (lat == null || lon == null) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  if (Math.abs(lat) < NULL_ISLAND_THRESHOLD && Math.abs(lon) < NULL_ISLAND_THRESHOLD) return null

  // Timestamp: accept unix seconds, unix ms, or ISO string
  let t: number
  const rawT = raw.t ?? raw.timestamp
  if (rawT == null) {
    t = Date.now() / 1000
  } else if (typeof rawT === "string") {
    t = new Date(rawT).getTime() / 1000
  } else {
    const num = Number(rawT)
    // If > 1e12, assume milliseconds
    t = num > 1e12 ? num / 1000 : num
  }

  // Anti-teleportation (within batch)
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

  // Update prev for anti-teleportation
  prevByMmsi.set(mmsi, { lat, lon, t })

  return { mmsi, lat, lon, t, sog, cog, hdg, vessel_name: vessel_name || null }
}

// ---------------------------------------------------------------------------
// Edge Function entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  // CORS
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

  // Auth
  const apiKey = req.headers.get("x-api-key") ?? req.headers.get("apikey")
  const expectedKey = Deno.env.get("INGEST_API_KEY")
  if (expectedKey && apiKey !== expectedKey) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Source name from header (default: pi4_rtlsdr)
  const sourceName = req.headers.get("x-source") ?? "pi4_rtlsdr"

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // Accept { positions: [...] } or bare array
  const rawRows: RawPosition[] = Array.isArray(body)
    ? body
    : Array.isArray((body as Record<string, unknown>).positions)
      ? (body as Record<string, unknown>).positions as RawPosition[]
      : []

  if (rawRows.length === 0) {
    return Response.json({ error: "No positions in payload" }, { status: 400 })
  }

  // --- Normalise + validate all rows ---
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

  // --- Ensure today's partition exists ---
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  )

  // Ensure partition for today and tomorrow (cheap idempotent call)
  const today = new Date()
  const tomorrow = new Date(today.getTime() + 86400000)
  await supabase.rpc("ensure_partition", { p_date: today.toISOString().slice(0, 10) }).catch(() => {})
  await supabase.rpc("ensure_partition", { p_date: tomorrow.toISOString().slice(0, 10) }).catch(() => {})

  // --- Call ingest_positions_v2 RPC ---
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
    console.error("[ingest-positions] RPC error:", rpcError.message)
    return Response.json({ error: "Storage failed", detail: rpcError.message }, { status: 500 })
  }

  const result = rpcResult as { accepted?: number; rejected?: number; error?: string } | null

  if (result?.error) {
    return Response.json({ error: result.error }, { status: 400 })
  }

  const totalAccepted = result?.accepted ?? valid.length
  const totalRejected = rejected + (result?.rejected ?? 0)

  console.log(
    `[ingest-positions] source=${sourceName} batch=${rawRows.length}`,
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
})
