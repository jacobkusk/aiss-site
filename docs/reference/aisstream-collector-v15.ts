/**
 * ais-collector — vier.blue Supabase Edge Function, version 15
 * Saved 2026-04-12 as reference for AISStream integration in aiss.network (Phase 3)
 *
 * What it does:
 *   - Opens WebSocket to wss://stream.aisstream.io/v0/stream
 *   - Subscribes to PositionReport + ShipStaticData for entire globe
 *   - Collects for 45 seconds, then batches to Supabase tables:
 *       ais_latest    (upsert on mmsi — current position)
 *       ais_trails    (ring buffer, 20 pts per vessel, 0.5nm gap filter)
 *       ais_positions (append-only, 0.3nm gap filter, only moving vessels)
 *   - Logs to aiss_ingest_log
 *
 * Key numbers:
 *   COLLECT_DURATION_MS = 45_000  (45 sec collection window)
 *   WS_CONNECT_TIMEOUT_MS = 8_000
 *   MAX_TRAIL = 20               (ring buffer size per vessel)
 *   TRAIL_DIST_NM = 0.5          (min gap before adding trail point)
 *   POSITION_DIST_NM = 0.3       (min gap before logging to positions)
 *   Only vessels with sog >= 0.5 kn get trail/position entries
 *
 * In vier.blue this ran every 2 minutes via cron → was the cause of
 * 397 MB ais_positions growth → stopped 2026-04-12.
 *
 * AISStream API key (from vier.blue secrets, confirmed working 2026-04-12):
 *   3199ea2786049dbc468de2585b19da9f1f7de0e1
 * NOTE: This key is tied to vier.blue. For aiss.network get/create a fresh key.
 *
 * When adapting for aiss.network:
 *   - Replace table writes with ingest_ais_batch RPC (already built)
 *   - Remove ais_trails / ais_latest (those tables don't exist in aiss.network)
 *   - Add reconnect loop (AISStream disconnects ~every 2 min by design)
 *   - Move API key to Supabase secret (AISSTREAM_API_KEY)
 *   - See ingest-ais edge function for the normalization + RPC call pattern
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const AIS_API_KEY = "3199ea2786049dbc468de2585b19da9f1f7de0e1";
const AIS_WS_URL = "wss://stream.aisstream.io/v0/stream";
const COLLECT_DURATION_MS = 45_000;
const WS_CONNECT_TIMEOUT_MS = 8_000;
const MAX_TRAIL = 20;
const TRAIL_DIST_NM = 0.5;
const POSITION_DIST_NM = 0.3;

function getDb() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

function distNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(a)) * 3440.065;
}

async function logIngest(db: any, result: any) {
  try {
    await db.from("aiss_ingest_log").insert({
      source_name: "aisstream-ws",
      positions_count: result.upserted ?? 0,
      received: result.received ?? 0,
      filtered: result.filtered ?? 0,
      upserted: result.upserted ?? 0,
      trails: result.trails ?? 0,
      error: result.error ?? null,
      debug: result.debug ? JSON.stringify(result.debug) : null,
    });
  } catch { /* don't fail on logging */ }
}

async function collect(): Promise<any> {
  const batch = new Map<number, any>();
  let received = 0;
  let filtered = 0;
  const debugLog: string[] = [];

  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let done = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = async (reason: string) => {
      if (done) return;
      done = true;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      debugLog.push(`Finishing: ${reason}, received=${received}, batch=${batch.size}`);
      try { ws?.close(); } catch { /* ignore */ }

      if (batch.size === 0) {
        const result = { received, filtered, upserted: 0, trails: 0, positions: 0, debug: debugLog };
        await logIngest(getDb(), result);
        resolve(result);
        return;
      }

      const rows = [...batch.values()];
      const db = getDb();
      let upserted = 0;
      let trailsAdded = 0;
      let positionsAdded = 0;
      const CHUNK = 500;

      try {
        const mmsis = rows.map(r => r.mmsi);
        const trailState = new Map<number, { trail_seq: number; trail_lat: number | null; trail_lon: number | null }>();
        for (let i = 0; i < mmsis.length; i += 1000) {
          const chunk = mmsis.slice(i, i + 1000);
          const { data } = await db.from("ais_latest")
            .select("mmsi, trail_seq, trail_lat, trail_lon")
            .in("mmsi", chunk);
          if (data) for (const r of data) trailState.set(r.mmsi, r);
        }

        const trailInserts: any[] = [];
        const positionInserts: any[] = [];
        const now = new Date().toISOString();
        for (const row of rows) {
          if (!row.sog || row.sog < 0.5) continue;
          const st = trailState.get(row.mmsi);
          const prevLat = st?.trail_lat;
          const prevLon = st?.trail_lon;
          const prevSeq = st?.trail_seq ?? -1;
          const d = (prevLat != null && prevLon != null) ? distNm(prevLat, prevLon, row.lat, row.lon) : 999;

          if (d >= TRAIL_DIST_NM) {
            const newSeq = (prevSeq + 1) % MAX_TRAIL;
            trailInserts.push({ mmsi: row.mmsi, seq: newSeq, lat: row.lat, lon: row.lon, heading: row.heading, speed: row.sog, recorded_at: now });
            row.trail_seq = newSeq;
            row.trail_lat = row.lat;
            row.trail_lon = row.lon;
          }

          if (d >= POSITION_DIST_NM) {
            positionInserts.push({
              mmsi: row.mmsi, lat: row.lat, lon: row.lon,
              speed: row.sog, heading: row.heading, cog: row.cog, sog: row.sog,
              ship_name: row.ship_name, ship_type: row.ship_type,
              nav_status: row.nav_status, destination: row.destination,
              recorded_at: now,
            });
          }
        }

        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          const { error } = await db.from("ais_latest").upsert(chunk, { onConflict: "mmsi" });
          if (error) { debugLog.push(`Upsert error: ${error.message}`); break; }
          upserted += chunk.length;
        }

        for (let i = 0; i < trailInserts.length; i += CHUNK) {
          const chunk = trailInserts.slice(i, i + CHUNK);
          const { error } = await db.from("ais_trails").upsert(chunk, { onConflict: "mmsi,seq" });
          if (error) debugLog.push(`Trail error: ${error.message}`);
          else trailsAdded += chunk.length;
        }

        for (let i = 0; i < positionInserts.length; i += CHUNK) {
          const chunk = positionInserts.slice(i, i + CHUNK);
          const { error } = await db.from("ais_positions").insert(chunk);
          if (error) debugLog.push(`Position error: ${error.message}`);
          else positionsAdded += chunk.length;
        }
      } catch (err) {
        debugLog.push(`DB error: ${String(err)}`);
      }

      const result = { received, filtered, upserted, trails: trailsAdded, positions: positionsAdded, debug: debugLog };
      await logIngest(db, result);
      resolve(result);
    };

    const timer = setTimeout(() => finish("timeout"), COLLECT_DURATION_MS);

    try {
      ws = new WebSocket(AIS_WS_URL);
    } catch (err) {
      clearTimeout(timer);
      finish(`ws constructor error: ${String(err)}`);
      return;
    }

    connectTimer = setTimeout(() => {
      if (!done) {
        debugLog.push("WS connect timeout");
        clearTimeout(timer);
        finish("ws connect timeout");
      }
    }, WS_CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      debugLog.push("Connected");
      try {
        ws!.send(JSON.stringify({
          APIKey: AIS_API_KEY,
          BoundingBoxes: [[[-90, -180], [90, 180]]],
          FilterMessageTypes: ["PositionReport", "ShipStaticData"]
        }));
      } catch (err) {
        debugLog.push(`Send error: ${String(err)}`);
        clearTimeout(timer);
        finish("ws send error");
      }
    };

    ws.onmessage = async (ev: MessageEvent) => {
      if (done) return;
      try {
        let raw: string;
        if (typeof ev.data === "string") raw = ev.data;
        else if (ev.data instanceof Blob) raw = await ev.data.text();
        else if (ev.data instanceof ArrayBuffer) raw = new TextDecoder().decode(ev.data);
        else return;

        const parsed = JSON.parse(raw);
        const messages = Array.isArray(parsed) ? parsed : [parsed];

        for (const msg of messages) {
          if (msg.MessageType === "ShipStaticData") {
            const s = msg.Message?.ShipStaticData;
            if (!s) continue;
            const mmsi = s.UserID as number;
            if (!mmsi) continue;
            const existing = batch.get(mmsi) || { mmsi, lat: 0, lon: 0, sog: 0, speed: 0, heading: 0, cog: 0, updated_at: new Date().toISOString() };
            if (s.Type != null) existing.ship_type = s.Type;
            if (s.ImoNumber) existing.imo_number = s.ImoNumber;
            if (s.Name) existing.ship_name = s.Name?.trim() || existing.ship_name || null;
            if (s.CallSign) existing.callsign = s.CallSign?.trim() || null;
            if (s.Destination) existing.destination = s.Destination?.trim() || null;
            if (s.Dimension) {
              const d = s.Dimension;
              if (d.A != null && d.B != null) existing.length = (d.A + d.B) || null;
              if (d.C != null && d.D != null) existing.beam = (d.C + d.D) || null;
            }
            if (s.MaximumStaticDraught != null) existing.draught = s.MaximumStaticDraught;
            if (s.Eta) {
              try {
                const e = s.Eta;
                if (e.Month && e.Day) {
                  const year = new Date().getFullYear();
                  existing.eta = new Date(year, e.Month - 1, e.Day, e.Hour ?? 0, e.Minute ?? 0).toISOString();
                }
              } catch { /* ignore */ }
            }
            batch.set(mmsi, existing);
            continue;
          }

          if (msg.MessageType !== "PositionReport") continue;
          const r = msg.Message?.PositionReport;
          if (!r) continue;
          received++;

          const mmsi = r.UserID as number;
          const lat = r.Latitude as number;
          const lon = r.Longitude as number;
          if (!mmsi || (lat === 0 && lon === 0)) continue;

          const sog = (r.Sog as number) ?? 0;
          const heading = (r.TrueHeading as number) ?? 0;
          const cog = (r.Cog as number) ?? 0;
          const rot = (r.RateOfTurn as number) ?? null;
          const posAcc = (r.PositionAccuracy as number) ?? null;
          const navStatus = r.NavigationalStatus ?? -1;
          const shipName = (msg.MetaData?.ShipName as string)?.trim() ?? null;

          const existing = batch.get(mmsi);
          batch.set(mmsi, {
            ...(existing ? { ship_type: existing.ship_type, imo_number: existing.imo_number, callsign: existing.callsign, destination: existing.destination, eta: existing.eta, length: existing.length, beam: existing.beam, draught: existing.draught } : {}),
            mmsi, lat, lon, sog, speed: sog, heading, cog, rot, position_accuracy: posAcc,
            nav_status: navStatus, ship_name: shipName || existing?.ship_name || null,
            updated_at: new Date().toISOString()
          });
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onerror = () => {
      debugLog.push("WS error event");
      clearTimeout(timer);
      finish("ws error");
    };

    ws.onclose = (e: CloseEvent) => {
      debugLog.push(`WS closed: code=${e.code}`);
      clearTimeout(timer);
      finish("ws closed");
    };
  });
}

Deno.serve(async (_req: Request) => {
  try {
    const result = await collect();
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    const errResult = { error: String(err), received: 0, upserted: 0 };
    try { await logIngest(getDb(), errResult); } catch { /* ignore */ }
    return new Response(JSON.stringify(errResult), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
});
