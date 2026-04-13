"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

interface HealthData {
  status: "ok" | "stale" | "down" | "error";
  last_ingest_ago_sec: number;
  last_ingest_at: string | null;
  last_batch_accepted: number;
  last_batch_rejected: number;
  positions_last_5min: number;
  positions_last_hour: number;
  active_vessels_30min: number;
}

interface Batch { ts: string; accepted: number; rejected: number; batch_ms: number; }

const STATUS_COLOR: Record<string, string> = { ok: "#00e676", stale: "#f59e0b", down: "#ef4444", error: "#ef4444" };
const STATUS_DK:    Record<string, string> = { ok: "ONLINE",  stale: "LANGSOM",  down: "NEDE",    error: "FEJL"   };

function ago(sec: number) {
  if (sec < 60)   return `${Math.round(sec)} sek siden`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min siden`;
  return `${Math.floor(sec / 3600)} timer siden`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function buildBuckets(batches: Batch[]) {
  const now = Date.now(), start = now - 24 * 60 * 60 * 1000, BUCKET = 5 * 60 * 1000;
  const n = Math.ceil((now - start) / BUCKET);
  const counts = new Array(n).fill(0);
  for (const b of batches) {
    const idx = Math.floor((new Date(b.ts).getTime() - start) / BUCKET);
    if (idx >= 0 && idx < n) counts[idx]++;
  }
  return counts.map((count, i) => ({ t: new Date(start + i * BUCKET), up: count > 0, count }));
}

function buildHourly(batches: Batch[]) {
  const hours: Record<number, number> = {};
  for (const b of batches) {
    const h = new Date(new Date(b.ts).setMinutes(0, 0, 0)).getTime();
    hours[h] = (hours[h] ?? 0) + b.accepted;
  }
  const now = new Date();
  return Array.from({ length: 24 }, (_, i) => {
    const t = new Date(now); t.setHours(t.getHours() - (23 - i), 0, 0, 0);
    return { label: t.getHours().toString().padStart(2, "0"), count: hours[t.getTime()] ?? 0 };
  });
}

export default function SourcePage() {
  const { id } = useParams<{ id: string }>();
  const [health,  setHealth]  = useState<HealthData | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [healthRes, batchRes] = await Promise.all([
          fetch("/api/health"),
          supabase.from("ingest_stats").select("ts, accepted, rejected, batch_ms")
            .gte("ts", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
            .order("ts", { ascending: false }),
        ]);
        if (!mounted) return;
        setHealth(await healthRes.json());
        setBatches((batchRes.data as Batch[]) ?? []);
        setLoading(false);
      } catch {}
    }
    load();
    const id = setInterval(load, 15_000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(i);
  }, []);

  const buckets    = buildBuckets(batches);
  const hourly     = buildHourly(batches);
  const upBuckets  = buckets.filter((b) => b.up).length;
  const uptimePct  = buckets.length > 0 ? ((upBuckets / buckets.length) * 100).toFixed(1) : "—";
  const maxHourly  = Math.max(...hourly.map((h) => h.count), 1);
  const liveAgoSec = health?.last_ingest_at
    ? Math.round((Date.now() - new Date(health.last_ingest_at).getTime()) / 1000)
    : null;
  const statusColor = health ? STATUS_COLOR[health.status] ?? "#5a8090" : "#5a8090";

  if (loading) return (
    <div style={{ minHeight: "100vh", background: "#040c14", display: "flex", alignItems: "center", justifyContent: "center", color: "#5a8090", fontFamily: "monospace", fontSize: 14 }}>
      Henter data...
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#040c14", color: "#c0d4dc", fontFamily: "var(--font-jetbrains, monospace)", padding: "28px 28px", maxWidth: 960, margin: "0 auto" }}>

      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
        <Link href="/map"    style={{ fontSize: 12, color: "#2ba8c8", textDecoration: "none", fontWeight: 700 }}>AISS</Link>
        <span style={{ color: "#3a5060" }}>/</span>
        <Link href="/health" style={{ fontSize: 12, color: "#7a9aaa", textDecoration: "none" }}>MONITOR</Link>
        <span style={{ color: "#3a5060" }}>/</span>
        <span style={{ fontSize: 12, color: "#c0d4dc", fontWeight: 700 }}>PI4 RTL-SDR</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#3a5060" }}>opdaterer hvert 15s</span>
      </div>
      <div style={{ fontSize: 12, color: "#4a6878", marginBottom: 32 }}>
        Raspberry Pi 4 med RTL-SDR USB modtager. Lytter på 162 MHz og opfanger AIS radiosignaler fra skibe inden for ~50 km.
      </div>

      {/* STATUS */}
      <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 12, padding: "20px 24px", background: "rgba(43,168,200,0.04)", border: `1px solid ${statusColor}33`, borderRadius: 8 }}>
        <div style={{ width: 16, height: 16, borderRadius: "50%", background: statusColor, boxShadow: `0 0 14px ${statusColor}`, flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: 32, fontWeight: 800, color: statusColor, letterSpacing: 2, lineHeight: 1 }}>
            {health ? STATUS_DK[health.status] ?? health.status.toUpperCase() : "—"}
          </div>
          <div style={{ fontSize: 13, color: "#7a9aaa", marginTop: 6 }}>
            {liveAgoSec != null ? `Sidst pakke modtaget: ${ago(liveAgoSec)}` : "Pi har ikke sendt data"}
          </div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: "#2ba8c8" }}>{uptimePct}%</div>
          <div style={{ fontSize: 12, color: "#5a8090", marginTop: 4 }}>uptime seneste 24t</div>
        </div>
      </div>

      {/* STATS */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 10 }}>
        {[
          { label: "Skibe hørt",       sub: "unikke seneste 30 min",            value: health?.active_vessels_30min, color: "#00e676" },
          { label: "AIS / time",       sub: "meldinger Pi sendte seneste time",  value: health?.positions_last_hour,  color: "#2ba8c8" },
          { label: "AIS / 5 min",      sub: "meldinger Pi sendte seneste 5 min", value: health?.positions_last_5min,  color: "#c0d4dc" },
          { label: "Fejl",             sub: "afviste meldinger — seneste batch",  value: health?.last_batch_rejected,  color: (health?.last_batch_rejected ?? 0) > 0 ? "#ef4444" : "#3a5060" },
        ].map((s) => (
          <div key={s.label} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "16px 18px" }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value ?? "—"}</div>
            <div style={{ fontSize: 13, color: "#c0d4dc", marginTop: 6, fontWeight: 600 }}>{s.label}</div>
            <div style={{ fontSize: 11, color: "#4a6878", marginTop: 3 }}>{s.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "#3a5060", marginBottom: 36 }}>
        Tallene viser hvad Pi'en har sendt til AISS databasen. Databasen er altid online — det er Pi'en der kan gå ned.
      </div>

      {/* UPTIME BAR */}
      <div style={{ marginBottom: 36 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#c0d4dc", marginBottom: 10 }}>
          Pi uptime — seneste 24 timer <span style={{ fontWeight: 400, color: "#4a6878", fontSize: 11 }}>(grøn = data modtaget · rød = Pi var tavs)</span>
        </div>
        <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 36 }}>
          {buckets.map((b, i) => (
            <div key={i} title={`${b.t.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" })} — ${b.count} batches`}
              style={{ flex: 1, height: b.up ? 36 : 12, borderRadius: 2, background: b.up ? "#00e676" : "#ef4444", opacity: b.up ? 0.75 : 0.45, transition: "height 0.3s" }} />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11, color: "#4a6878" }}>
          <span>24 timer siden</span><span>nu</span>
        </div>
      </div>

      {/* HOURLY */}
      <div style={{ marginBottom: 36 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#c0d4dc", marginBottom: 10 }}>
          AIS meldinger Pi sendte pr. time <span style={{ fontWeight: 400, color: "#4a6878", fontSize: 11 }}>(seneste 24 timer)</span>
        </div>
        <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 60 }}>
          {hourly.map((h, i) => (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div title={`Kl. ${h.label} — ${h.count} meldinger`}
                style={{ width: "100%", height: h.count > 0 ? Math.max(4, (h.count / maxHourly) * 52) : 2, background: h.count > 0 ? "#2ba8c8" : "#1a3040", borderRadius: "2px 2px 0 0" }} />
              {i % 4 === 0 && <div style={{ fontSize: 9, color: "#3a5060" }}>{h.label}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* LIVE FEED */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#c0d4dc", marginBottom: 6 }}>
          Live pakker fra Pi <span style={{ fontWeight: 400, color: "#4a6878", fontSize: 11 }}>(hver linje = én pakke Pi har sendt · opdaterer hvert 15s)</span>
        </div>
        <div style={{ background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: "12px 16px" }}>
          {batches.length === 0 ? (
            <div style={{ fontSize: 13, color: "#4a6878" }}>Pi har ikke sendt data de seneste 24 timer</div>
          ) : batches.slice(0, 40).map((b, i) => (
            <div key={i} style={{ display: "flex", gap: 20, fontSize: 13, color: b.rejected > 0 ? "#f59e0b" : "#7a9aaa", borderBottom: "1px solid rgba(255,255,255,0.03)", padding: "5px 0" }}>
              <span style={{ color: "#4a6878", minWidth: 80 }}>{fmtTime(b.ts)}</span>
              <span style={{ color: "#00e676", minWidth: 80 }}>+{b.accepted} skibe</span>
              {b.rejected > 0 && <span style={{ color: "#ef4444" }}>!{b.rejected} fejl</span>}
              <span style={{ marginLeft: "auto", color: "#3a5060" }}>{b.batch_ms} ms</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
