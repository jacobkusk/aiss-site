"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import type { TrackMap, VesselPoint } from "./ReplayLayer";

interface Props {
  onLoad: (tracks: TrackMap, start: number, end: number) => void;
  onTimeChange: (t: number) => void;
  onClose: () => void;
  currentTime: number | null;
  start: number | null;
  end: number | null;
  dimmed?: boolean;
}

const SPEEDS = [1, 5, 15, 60, 300]; // realtime multipliers


function utcOffsetLabel() {
  const off = -new Date().getTimezoneOffset();
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  return `UTC${off >= 0 ? "+" : "-"}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}
const TZ_LABEL = utcOffsetLabel();

function fmtTime(epoch: number) {
  return new Date(epoch).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function fmtDate(epoch: number) {
  return new Date(epoch).toLocaleDateString([], { day: "2-digit", month: "short" });
}

function toDateStr(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function ReplayControl({ onLoad, onTimeChange, onClose, currentTime, start, end, dimmed }: Props) {
  const [dateStr, setDateStr] = useState(() => toDateStr(new Date()));
  const [loading, setLoading] = useState(false);
  const [playing,  setPlaying]  = useState(false);
  const [speedIdx, setSpeedIdx] = useState(2); // default 15×
  const [vesselCount, setVesselCount] = useState<number | null>(null);

  const rafRef   = useRef<number | undefined>(undefined);
  const lastRef  = useRef<number | null>(null);

  // Animation loop
  useEffect(() => {
    if (!playing || currentTime == null || start == null || end == null) return;
    const speed = SPEEDS[speedIdx];

    const tick = (now: number) => {
      if (lastRef.current != null) {
        const wall = now - lastRef.current; // ms of wall time elapsed
        const sim  = wall * speed;          // ms of simulated time
        const next = Math.min(currentTime + sim, end);
        onTimeChange(next);
        if (next >= end) { setPlaying(false); return; }
      }
      lastRef.current = now;
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastRef.current = null;
    };
  }, [playing, speedIdx, currentTime, start, end, onTimeChange]);

  const handleLoad = useCallback(async () => {
    setLoading(true);
    setPlaying(false);
    const dayStart = new Date(dateStr + "T00:00:00");
    const dayEnd   = new Date(dateStr + "T23:59:59");
    const now      = new Date();
    const { data, error } = await supabase.rpc("get_tracks_in_range", {
      p_start: dayStart.toISOString(),
      p_end:   (dayEnd > now ? now : dayEnd).toISOString(),
    });
    setLoading(false);
    if (error) { console.error("[replay] rpc error:", error); return; }
    if (!data) { console.warn("[replay] no data returned"); return; }

    // Supabase JS may wrap scalar JSON in various formats — unwrap defensively
    let raw: any = data;
    if (typeof raw === "string") try { raw = JSON.parse(raw); } catch { /* keep as-is */ }
    if (Array.isArray(raw)) raw = raw[0];
    if (typeof raw === "string") try { raw = JSON.parse(raw); } catch { /* keep as-is */ }
    if (raw?.get_tracks_in_range != null) raw = raw.get_tracks_in_range;
    if (typeof raw === "string") try { raw = JSON.parse(raw); } catch { /* keep as-is */ }
    raw = raw ?? {};

    console.log("[replay] loaded:", raw.points?.length ?? 0, "points");
    const pts: { mmsi: number; name: string | null; lon: number; lat: number; sog: number | null; cog: number | null; t: number }[] = raw.points ?? [];

    const map: TrackMap = new Map();
    for (const p of pts) {
      if (!map.has(p.mmsi)) map.set(p.mmsi, { name: p.name, points: [] });
      map.get(p.mmsi)!.points.push({ t: p.t, lat: p.lat, lon: p.lon, sog: p.sog, cog: p.cog });
    }
    // Sort each vessel's points by time
    map.forEach((v) => v.points.sort((a, b) => a.t - b.t));
    setVesselCount(map.size);
    const s = dayStart.getTime();
    const e = Math.min(dayEnd.getTime(), now.getTime());
    onLoad(map, s, e);
    // Start at beginning of available data (first point), or start-of-day
    let firstPointMs = s;
    map.forEach((v) => {
      if (v.points.length > 0) {
        const pt = v.points[0].t * 1000;
        if (firstPointMs === s || pt < firstPointMs) firstPointMs = pt;
      }
    });
    onTimeChange(Math.max(s, firstPointMs));
  }, [dateStr, onLoad, onTimeChange]);

  const handleScrub = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPlaying(false);
    onTimeChange(Number(e.target.value));
  }, [onTimeChange]);

  const togglePlay = () => {
    if (playing) { setPlaying(false); return; }
    // If at end, restart
    if (currentTime != null && end != null && currentTime >= end) onTimeChange(start ?? currentTime);
    setPlaying(true);
  };

  const loaded = currentTime != null && start != null && end != null;

  return (
    <div style={{
      position: "absolute",
      bottom: 20,
      left: "50%",
      transform: "translateX(-50%)",
      width: "min(600px, calc(100vw - 40px))",
      opacity: dimmed ? 0.35 : 1,
      pointerEvents: dimmed ? "none" : "auto",
      transition: "opacity 0.2s",
      background: "rgba(4, 12, 20, 0.92)",
      border: "1px solid rgba(245, 158, 11, 0.25)",
      borderRadius: 8,
      padding: "12px 14px 10px",
      zIndex: 10,
      backdropFilter: "blur(6px)",
      fontFamily: "var(--font-mono, monospace)",
      userSelect: "none",
    }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: "#f59e0b", letterSpacing: "0.06em" }}>⏱ REPLAY</span>
        <input
          type="date"
          value={dateStr}
          max={toDateStr(new Date())}
          onChange={(e) => setDateStr(e.target.value)}
          style={inputStyle}
        />
        <button onClick={handleLoad} disabled={loading} style={btnStyle("#2ba8c8")}>
          {loading ? "..." : "LOAD"}
        </button>
        <div style={{ flex: 1 }} />
        {vesselCount != null && (
          <span style={{ fontSize: 10, color: "#5a8090" }}>{vesselCount} vessels</span>
        )}
        <button onClick={onClose} style={{ ...btnStyle("#5a8090"), padding: "4px 8px" }}>✕</button>
      </div>

      {loaded && (
        <>
          {/* Scrubber */}
          <div style={{ position: "relative", marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 10, color: "#5a8090" }}>{fmtDate(start!)} {fmtTime(start!)}</span>
              <span style={{ fontSize: 11, color: "#f59e0b", fontWeight: "bold" }}>
                {fmtTime(currentTime!)}
                <span style={{ fontSize: 9, color: "#5a8090", marginLeft: 4, fontWeight: "normal" }}>{TZ_LABEL}</span>
              </span>
              <span style={{ fontSize: 10, color: "#5a8090" }}>{fmtDate(end!)} {fmtTime(end!)}</span>
            </div>
            <input
              type="range"
              min={start!}
              max={end!}
              step={1000}
              value={currentTime!}
              onChange={handleScrub}
              style={{ width: "100%", accentColor: "#f59e0b", cursor: "pointer" }}
            />
          </div>

          {/* Controls */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={togglePlay} style={btnStyle("#f59e0b", true)}>
              {playing ? "⏸" : "▶"}
            </button>
            <span style={{ fontSize: 10, color: "#5a8090" }}>speed</span>
            {SPEEDS.map((s, i) => (
              <button
                key={s}
                onClick={() => setSpeedIdx(i)}
                style={{
                  ...btnStyle(i === speedIdx ? "#f59e0b" : "#5a8090"),
                  padding: "3px 7px",
                  opacity: i === speedIdx ? 1 : 0.5,
                }}
              >
                {s}×
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: "#5a8090" }}>
              {Math.round((currentTime! - start!) / 60_000)} / {Math.round((end! - start!) / 60_000)} min
            </span>
          </div>
        </>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(4, 12, 20, 0.9)",
  border: "1px solid rgba(245, 158, 11, 0.3)",
  borderRadius: 5,
  color: "#c8dce8",
  fontSize: 11,
  padding: "4px 7px",
  outline: "none",
  fontFamily: "inherit",
  colorScheme: "dark",
};

function btnStyle(color: string, big = false): React.CSSProperties {
  return {
    background: "rgba(4, 12, 20, 0.7)",
    border: `1px solid ${color}55`,
    borderRadius: 5,
    color,
    fontSize: big ? 14 : 11,
    padding: big ? "4px 12px" : "4px 9px",
    cursor: "pointer",
    fontFamily: "inherit",
  };
}
