// alert-health — Supabase Edge Function (v5)
// Called by pg_cron every 5 minutes.
// Alerts on:
//   1. Pi ingest down > 10 min
//   2. Any critical RPC broken
// Recovery emails when issues resolve.
//
// Changes vs v4:
//   - Top-level try/catch wrapper per docs/EDGE-FUNCTION-RUNBOOK.md §1.2.
//     Previously an unhandled fetch/Resend failure would show in Supabase's
//     logs panel only as "500 | 197ms" with no body. Now the stack surfaces
//     in the HTTP body so pg_net diagnostics can read it.
//   - Individual try/catch around the Resend fetch and the alert_state
//     upsert so a transient provider failure doesn't cascade into a
//     pg_cron alert for the alerter itself.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

Deno.serve(async (req: Request) => {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as Error
    console.error("[alert-health] FATAL:", err.message, err.stack)
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

  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")
  const ALERT_EMAIL   = Deno.env.get("ALERT_EMAIL") ?? "jacob@jacobkusk.dk"

  if (!RESEND_API_KEY) {
    return new Response("RESEND_API_KEY not set", { status: 500 })
  }

  // ── 1. Ingest health ──────────────────────────────────────────────
  const { data: health, error: healthErr } = await supabase.rpc("get_ingest_health")
  if (healthErr) return new Response(`health error: ${healthErr.message}`, { status: 500 })

  const lastTs = health.last_ingest?.ts ? new Date(health.last_ingest.ts) : null
  const ageMs  = lastTs ? Date.now() - lastTs.getTime() : Infinity
  const piDown = ageMs > 10 * 60 * 1000

  // ── 2. RPC health ─────────────────────────────────────────────────
  const { data: rpcRows } = await supabase.rpc("get_rpc_health")
  const brokenRpcs: { rpc_name: string; detail: string }[] =
    (rpcRows ?? []).filter((r: { ok: boolean }) => !r.ok)
  const rpcDown = brokenRpcs.length > 0

  // ── 3. Alert state ────────────────────────────────────────────────
  const { data: stateRow } = await supabase
    .from("alert_state")
    .select("was_down, last_alerted_at, extra")
    .eq("id", 1)
    .single()

  const wasDown        = stateRow?.was_down ?? false
  const lastAlertedAt  = stateRow?.last_alerted_at ? new Date(stateRow.last_alerted_at) : null
  const prevBrokenRpcs: string[] = stateRow?.extra?.broken_rpcs ?? []
  const alertCooldown  = !lastAlertedAt || (Date.now() - lastAlertedAt.getTime()) > 30 * 60 * 1000

  const newBrokenRpcs = brokenRpcs.filter((r) => !prevBrokenRpcs.includes(r.rpc_name))
  const fixedRpcs     = prevBrokenRpcs.filter((name) => !brokenRpcs.find((r) => r.rpc_name === name))

  const alerts: { subject: string; html: string }[] = []

  // Pi down alert
  if (piDown && (!wasDown || alertCooldown)) {
    const agoMin = Math.round(ageMs / 60000)
    alerts.push({
      subject: `🔴 AISS Pi nede — ${agoMin} min uden data`,
      html: `
        <p><strong>Pi sender ikke data.</strong></p>
        <p>Sidst set: ${lastTs ? lastTs.toLocaleString("da-DK") : "ukendt"} (${agoMin} min siden)</p>
        <p>Genstart Pi fysisk. Service starter automatisk.</p>
        <p><a href="https://aiss.network/health">Se health dashboard</a></p>
      `,
    })
  }

  // Pi recovery
  if (!piDown && wasDown) {
    alerts.push({
      subject: "🟢 AISS Pi er oppe igen",
      html: `
        <p>Pi sender data igen.</p>
        <p>${health.positions_last_5min} positioner de seneste 5 min · ${health.active_vessels_30min} aktive fartøjer.</p>
      `,
    })
  }

  // Broken RPCs alert
  if (newBrokenRpcs.length > 0) {
    const rows = newBrokenRpcs
      .map((r) => `<tr>
        <td style="padding:6px 12px;font-family:monospace;color:#ef4444">${r.rpc_name}</td>
        <td style="padding:6px 12px;color:#999;font-size:12px">${r.detail ?? "ukent fejl"}</td>
      </tr>`)
      .join("")

    alerts.push({
      subject: `🔴 AISS API brudt — ${newBrokenRpcs.map((r) => r.rpc_name).join(", ")}`,
      html: `
        <p><strong>${newBrokenRpcs.length} kritisk${newBrokenRpcs.length > 1 ? "e" : ""} endpoint${newBrokenRpcs.length > 1 ? "s" : ""} er brudt.</strong></p>
        <p>Sandsynlig årsag: en migration droppede eller omdøbte en tabel som en funktion afhænger af.</p>
        <table style="border-collapse:collapse;margin:16px 0;background:#111;border-radius:6px">
          <thead><tr>
            <th style="padding:6px 12px;text-align:left;color:#888;font-size:11px">RPC</th>
            <th style="padding:6px 12px;text-align:left;color:#888;font-size:11px">FEJL</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p>Vis denne email til Claude og bed om en fix-migration.</p>
        <p><a href="https://aiss.network/health">Se health dashboard</a></p>
      `,
    })
  }

  // RPC recovery
  if (fixedRpcs.length > 0) {
    alerts.push({
      subject: `🟢 AISS API genoprettet — ${fixedRpcs.join(", ")}`,
      html: `<p>Disse endpoints virker igen: <strong>${fixedRpcs.join(", ")}</strong></p>`,
    })
  }

  // ── 4. Send emails ───────────────────────────────────────────────
  // Wrap each fetch — a Resend outage must NOT cascade into a 500 for the alerter.
  let resendFailures = 0
  for (const alert of alerts) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from:    "AISS Monitor <monitor@aiss.network>",
          to:      [ALERT_EMAIL],
          subject: alert.subject,
          html:    alert.html,
        }),
      })
      if (!res.ok) {
        resendFailures++
        console.error(`[alert-health] Resend returned ${res.status} for "${alert.subject}"`)
      }
    } catch (e) {
      resendFailures++
      console.error(`[alert-health] Resend fetch failed for "${alert.subject}":`, (e as Error).message)
    }
  }

  // ── 5. Update state ──────────────────────────────────────────────
  const nowDown = piDown || rpcDown
  const shouldUpdateState = alerts.length > 0 || (nowDown !== wasDown)

  if (shouldUpdateState) {
    try {
      const { error: upsertErr } = await supabase.from("alert_state").upsert({
        id: 1,
        was_down: nowDown,
        last_alerted_at: alerts.length > 0 ? new Date().toISOString() : stateRow?.last_alerted_at,
        extra: { broken_rpcs: brokenRpcs.map((r) => r.rpc_name) },
      })
      if (upsertErr) console.error("[alert-health] alert_state upsert error:", upsertErr.message)
    } catch (e) {
      console.error("[alert-health] alert_state upsert threw:", (e as Error).message)
    }
  }

  return new Response(
    JSON.stringify({
      piDown, wasDown,
      brokenRpcs: brokenRpcs.map((r) => r.rpc_name),
      alertsSent: alerts.length,
      resendFailures,
    }),
    { headers: { "Content-Type": "application/json" } }
  )
}
