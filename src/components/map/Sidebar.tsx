"use client";

import { useEffect, useRef, useState } from "react";
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

interface FeedRow {
  id: number;
  ts: string;
  source_name: string;
  accepted: number;
  rejected: number;
  batch_ms: number;
}

function ago(sec: number): string {
  if (sec < 60)  return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

const STATUS_COLOR: Record<string, string> = {
  ok:    "#00e676",
  stale: "#f59e0b",
  down:  "#ef4444",
  error: "#ef4444",
};

export default function Sidebar() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Poll /api/health every 15s
  useEffect(() => {
    let mounted = true;
    async function poll() {
      try {
        const res = await fetch("/api/health");
        const data = await res.json();
        if (mounted) setHealth(data);
      } catch {}
    }
    poll();
    const id = setInterval(poll, 15_000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  // Poll ingest_stats for live feed every 5s
  useEffect(() => {
    let mounted = true;
    async function poll() {
      const { data } = await supabase
        .from("ingest_stats")
        .select("id, ts, source_name, accepted, rejected, batch_ms")
        .order("ts", { ascending: false })
        .limit(20);
      if (mounted && data) {
        setFeed((data as FeedRow[]).reverse());
      }
    }
    poll();
    const id = setInterval(poll, 5_000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  // Auto-scroll feed
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed]);

  const statusColor = health ? STATUS_COLOR[health.status] : "#5a8090";
  const statusLabel = health?.status ?? "—";

  return (
    <div style={{
      width: 220,
      flexShrink: 0,
      height: "100%",
      background: "rgba(4, 12, 20, 0.92)",
      borderRight: "1px solid rgba(43, 168, 200, 0.1)",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* Logo */}
      <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "1px", color: "#2ba8c8" }}>AISS</div>
        <div style={{ fontSize: 9, color: "#5a8090", letterSpacing: "0.5px", marginTop: 1 }}>Ocean Evidence Protocol</div>
      </div>

      {/* Status dot + label */}
      <div style={{ padding: "10px 16px 8px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", gap: 7 }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: statusColor,
          boxShadow: health?.status === "ok" ? `0 0 6px ${statusColor}` : "none",
        }} />
        <span style={{ fontSize: 10, fontWeight: 700, color: statusColor, letterSpacing: "0.8px", textTransform: "uppercase" }}>
          {statusLabel}
        </span>
        {health && (
          <span style={{ fontSize: 9, color: "#5a8090", marginLeft: "auto" }}>
            {ago(health.last_ingest_ago_sec)} ago
          </span>
        )}
      </div>

      {/* Stats grid */}
      <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 0" }}>
        <Stat label="ACTIVE" value={health?.active_vessels_30min ?? "—"} color="#00e676" />
        <Stat label="POS/HR" value={health?.positions_last_hour ?? "—"} color="#2ba8c8" />
        <Stat label="LAST 5M" value={health?.positions_last_5min ?? "—"} color="#7a9aaa" />
        <Stat label="REJECTED" value={health?.last_batch_rejected ?? "—"} color={health?.last_batch_rejected ? "#ef4444" : "#5a8090"} />
      </div>

      {/* Live ingest feed */}
      <div style={{ padding: "8px 16px 6px", fontSize: 9, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: "#5a8090" }}>
        Ingest feed
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", scrollbarWidth: "none", paddingBottom: 8 }}>
        {feed.length === 0 ? (
          <div style={{ padding: "0 16px", fontSize: 10, fontFamily: "monospace", color: "#5a8090" }}>waiting...</div>
        ) : (
          feed.map((row) => {
            const t = new Date(row.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
            const color = row.rejected > 0 ? "#f59e0b" : "#7a9aaa";
            return (
              <div key={row.id} style={{ padding: "1px 16px", fontSize: 10, fontFamily: "monospace", color, lineHeight: 1.7, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {t} +{row.accepted}{row.rejected > 0 ? ` !${row.rejected}` : ""} {row.batch_ms}ms
              </div>
            );
          })
        )}
      </div>

      {/* Monitor link */}
      <div style={{ padding: "8px 12px", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <Link href="/health" style={{ textDecoration: "none" }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "7px 10px",
            borderRadius: 6,
            background: "rgba(43,168,200,0.05)",
            border: "1px solid rgba(43,168,200,0.12)",
            cursor: "pointer",
          }}>
            <div style={{
              width: 7, height: 7, borderRadius: "50%",
              background: statusColor,
              boxShadow: health?.status === "ok" ? `0 0 5px ${statusColor}` : "none",
              flexShrink: 0,
            }} />
            <span style={{ fontSize: 10, fontWeight: 600, color: "#7a9aaa", letterSpacing: "0.5px" }}>System Monitor</span>
            <span style={{ marginLeft: "auto", fontSize: 10, color: "#3a5060" }}>→</span>
          </div>
        </Link>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "monospace", color, lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 9, color: "#5a8090", letterSpacing: "0.5px", marginTop: 2 }}>{label}</div>
    </div>
  );
}
