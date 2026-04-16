// auto-heal — Supabase Edge Function (v2)
// Runs every 5 minutes via pg_cron.
// Unlike alert-health (which emails), this function FIXES problems.
//
// Checks & auto-fixes:
//   1. Probes ingest-positions Edge Function — if broken, redeploys from stored known-good code
//   2. Ensures daily partitions exist (today + next 2 days)
//   3. Detects data flow gaps and logs diagnostics
//   4. Cleans up old heal_log entries
//
// Changes vs v1:
//   - Top-level try/catch wrapper per docs/EDGE-FUNCTION-RUNBOOK.md §1.2.
//     Existing per-check try/catch is preserved, but the final heal_log
//     inserts (which sit outside those blocks) are now protected too.
//
// All actions logged to heal_log table.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const PROJECT_ID = "grugesypzsebqcxcdseu"

interface HealResult {
  check: string
  status: "ok" | "warning" | "healed" | "failed"
  detail: string
  action?: string
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req)
  } catch (e) {
    const err = e as Error
    console.error("[auto-heal] FATAL:", err.message, err.stack)
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

  const results: HealResult[] = []

  // ═══════════════════════════════════════════════════════════════════
  // CHECK 1: Probe ingest-positions Edge Function
  // ═══════════════════════════════════════════════════════════════════
  try {
    const probeUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/ingest-positions`
    const ingestKey = Deno.env.get("INGEST_API_KEY") ?? ""

    // Send a minimal test payload with an obviously invalid MMSI (will be rejected but function should respond 200/400, not 500)
    const testPayload = [{ mmsi: 1, lat: 0, lon: 0, t: Date.now() / 1000 }]

    const probeResp = await fetch(probeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ingestKey,
        "x-source": "auto-heal-probe",
      },
      body: JSON.stringify(testPayload),
    })

    const probeBody = await probeResp.text()

    if (probeResp.status === 500) {
      // Edge Function is broken! Try to redeploy.
      results.push({
        check: "edge_probe",
        status: "warning",
        detail: `ingest-positions returned 500: ${probeBody.slice(0, 200)}`,
        action: "attempting redeploy",
      })

      // Attempt auto-redeploy using Supabase Management API
      const pat = Deno.env.get("SUPABASE_PAT")
      if (pat) {
        try {
          // Get known-good code from database
          const { data: stored } = await supabase
            .from("edge_function_store")
            .select("code, version")
            .eq("slug", "ingest-positions")
            .single()

          if (stored?.code) {
            // Use Management API to redeploy
            const deployResp = await fetch(
              `https://api.supabase.com/v1/projects/${PROJECT_ID}/functions/ingest-positions/body`,
              {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${pat}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  body: stored.code,
                  verify_jwt: false,
                }),
              }
            )

            if (deployResp.ok) {
              results.push({
                check: "edge_redeploy",
                status: "healed",
                detail: `Redeployed ingest-positions v${stored.version} from stored known-good code`,
                action: "redeploy_success",
              })
            } else {
              const errText = await deployResp.text()
              results.push({
                check: "edge_redeploy",
                status: "failed",
                detail: `Redeploy failed (${deployResp.status}): ${errText.slice(0, 200)}`,
                action: "redeploy_failed",
              })
            }
          } else {
            results.push({
              check: "edge_redeploy",
              status: "failed",
              detail: "No stored known-good code found in edge_function_store",
            })
          }
        // deno-lint-ignore no-explicit-any
        } catch (redeployErr: any) {
          results.push({
            check: "edge_redeploy",
            status: "failed",
            detail: `Redeploy error: ${redeployErr.message}`,
          })
        }
      } else {
        results.push({
          check: "edge_redeploy",
          status: "failed",
          detail: "SUPABASE_PAT not set — cannot auto-redeploy. Set it as Edge Function secret to enable.",
        })
      }
    } else {
      // Function responded (200, 400, 401 are all fine — it means the function is alive)
      results.push({
        check: "edge_probe",
        status: "ok",
        detail: `ingest-positions responded ${probeResp.status}`,
      })
    }
  // deno-lint-ignore no-explicit-any
  } catch (probeErr: any) {
    results.push({
      check: "edge_probe",
      status: "failed",
      detail: `Probe failed entirely: ${probeErr.message}`,
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // CHECK 2: Ensure partitions exist (today + next 2 days)
  // ═══════════════════════════════════════════════════════════════════
  try {
    const dates: string[] = []
    for (let i = 0; i < 3; i++) {
      const d = new Date(Date.now() + i * 86400000)
      dates.push(d.toISOString().slice(0, 10))
    }

    for (const date of dates) {
      const { error } = await supabase.rpc("ensure_partition", { p_date: date })
      if (error) {
        results.push({
          check: "partition",
          status: "failed",
          detail: `ensure_partition(${date}) failed: ${error.message}`,
        })
      }
    }

    results.push({
      check: "partition",
      status: "ok",
      detail: `Partitions ensured for ${dates.join(", ")}`,
    })
  // deno-lint-ignore no-explicit-any
  } catch (partErr: any) {
    results.push({
      check: "partition",
      status: "failed",
      detail: `Partition check error: ${partErr.message}`,
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // CHECK 3: Data flow — are positions arriving?
  // ═══════════════════════════════════════════════════════════════════
  try {
    const { data: health } = await supabase.rpc("get_ingest_health")

    const lastTs = health?.last_ingest?.ts ? new Date(health.last_ingest.ts) : null
    const ageMs = lastTs ? Date.now() - lastTs.getTime() : Infinity
    const ageMin = Math.round(ageMs / 60000)

    const pos5min = health?.positions_last_5min ?? 0
    const posHour = health?.positions_last_hour ?? 0
    const activeVessels = health?.active_vessels_30min ?? 0

    if (ageMs > 15 * 60 * 1000) {
      results.push({
        check: "data_flow",
        status: "warning",
        detail: `No data for ${ageMin} min. Last ingest: ${lastTs?.toISOString() ?? "never"}. Active vessels: ${activeVessels}`,
      })
    } else {
      results.push({
        check: "data_flow",
        status: "ok",
        detail: `Data flowing. Last: ${ageMin}min ago. 5min: ${pos5min} pos, 1h: ${posHour} pos, vessels: ${activeVessels}`,
      })
    }
  // deno-lint-ignore no-explicit-any
  } catch (flowErr: any) {
    results.push({
      check: "data_flow",
      status: "failed",
      detail: `Data flow check error: ${flowErr.message}`,
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // CHECK 4: RPC health (same as alert-health, but log don't email)
  // ═══════════════════════════════════════════════════════════════════
  try {
    const { data: rpcRows } = await supabase.rpc("get_rpc_health")
    const broken = (rpcRows ?? []).filter((r: { ok: boolean }) => !r.ok)

    if (broken.length > 0) {
      results.push({
        check: "rpc_health",
        status: "warning",
        // deno-lint-ignore no-explicit-any
        detail: `${broken.length} broken RPCs: ${broken.map((r: any) => r.rpc_name).join(", ")}`,
      })
    } else {
      results.push({
        check: "rpc_health",
        status: "ok",
        detail: "All RPCs healthy",
      })
    }
  // deno-lint-ignore no-explicit-any
  } catch (rpcErr: any) {
    results.push({
      check: "rpc_health",
      status: "failed",
      detail: `RPC health check error: ${rpcErr.message}`,
    })
  }

  // ═══════════════════════════════════════════════════════════════════
  // CHECK 5: Cleanup old heal_log entries (keep 7 days)
  // ═══════════════════════════════════════════════════════════════════
  try {
    await supabase.rpc("cleanup_heal_log")
  } catch (_) {
    // non-critical
  }

  // ═══════════════════════════════════════════════════════════════════
  // LOG ALL RESULTS
  // ═══════════════════════════════════════════════════════════════════
  const logRows = results.map((r) => ({
    check_name: r.check,
    status: r.status,
    detail: r.detail,
    action_taken: r.action ?? null,
  }))

  // Only log non-ok results to keep the table clean, plus one summary
  const problems = logRows.filter((r) => r.status !== "ok")
  if (problems.length > 0) {
    try {
      const { error } = await supabase.from("heal_log").insert(problems)
      if (error) console.error("[auto-heal] heal_log insert (problems) error:", error.message)
    } catch (e) {
      console.error("[auto-heal] heal_log insert (problems) threw:", (e as Error).message)
    }
  }

  // Always log a summary row every hour (on the :00 check)
  const minute = new Date().getMinutes()
  if (minute < 5) {
    try {
      const { error } = await supabase.from("heal_log").insert({
        check_name: "hourly_summary",
        status: problems.length > 0 ? "warning" : "ok",
        detail: `Checks: ${results.length}. Problems: ${problems.length}. ${results.map((r) => `${r.check}:${r.status}`).join(", ")}`,
      })
      if (error) console.error("[auto-heal] heal_log insert (summary) error:", error.message)
    } catch (e) {
      console.error("[auto-heal] heal_log insert (summary) threw:", (e as Error).message)
    }
  }

  const overallStatus = results.some((r) => r.status === "failed")
    ? "UNHEALTHY"
    : results.some((r) => r.status === "warning" || r.status === "healed")
    ? "HEALING"
    : "HEALTHY"

  return new Response(
    JSON.stringify({
      status: overallStatus,
      ts: new Date().toISOString(),
      checks: results,
    }),
    { headers: { "Content-Type": "application/json" } }
  )
}
