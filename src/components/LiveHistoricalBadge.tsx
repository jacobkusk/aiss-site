"use client";

import { useState, useEffect } from "react";

interface Props {
  isLive: boolean;
  vesselCount: number;
  date: string | null;
  routeCount: number;
  sidebarOpen?: boolean;
}

function useClock() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

export default function LiveHistoricalBadge({ isLive, vesselCount, date, routeCount, sidebarOpen = true }: Props) {
  const now = useClock();
  const offsetHours = -now.getTimezoneOffset() / 60;
  const utcLabel = `UTC${offsetHours >= 0 ? "+" : ""}${offsetHours}`;
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <div
      className="absolute top-4 z-30 flex flex-col rounded-lg px-3 py-2"
      style={{
        left: sidebarOpen ? "16px" : "60px",
        background: "var(--bg-panel)",
        backdropFilter: "blur(20px)",
        border: "1px solid var(--border)",
        transition: "left 0.15s",
        minWidth: "160px",
      }}
    >
      {isLive ? (
        <>
          <div className="flex items-center gap-2">
            <span
              className="inline-block w-2 h-2 rounded-full pulse-live"
              style={{ background: "var(--green-live)" }}
            />
            <span className="text-xs font-bold font-mono" style={{ color: "var(--green-live)" }}>
              LIVE
            </span>
            <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
              {vesselCount.toLocaleString()} vessels
            </span>
          </div>
          <div className="font-mono" style={{ fontSize: "18px", fontWeight: 700, color: "#ffffff", lineHeight: 1.2, marginTop: "4px" }}>
            {timeStr}
          </div>
          <div style={{ fontSize: "9px", color: "rgba(255,255,255,0.75)", fontFamily: "var(--font-mono)", letterSpacing: "0.06em" }}>
            {utcLabel}
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: "var(--amber-historical)" }}
          />
          <span className="text-xs font-bold font-mono" style={{ color: "var(--amber-historical)" }}>
            HISTORICAL
          </span>
          <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
            {date} · {routeCount} routes
          </span>
        </div>
      )}
    </div>
  );
}
