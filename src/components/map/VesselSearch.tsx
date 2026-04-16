"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabase";

interface Result {
  mmsi: number;
  name: string | null;
  lat: number | null;
  lon: number | null;
  last_t: number | null;
  first_t: number | null;
  is_historical: boolean;
}

interface Props {
  onSelect: (r: Result) => void;
}

export default function VesselSearch({ onSelect }: Props) {
  const [query, setQuery]     = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen]       = useState(false);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    const { data } = await supabase.rpc("search_vessels", { q: q.trim() });
    setLoading(false);
    if (Array.isArray(data)) setResults(data as Result[]);
    else if (data) setResults(data as Result[]);
  }, []);

  const handleChange = (v: string) => {
    setQuery(v);
    setOpen(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(v), 220);
  };

  const handleSelect = (r: Result) => {
    setQuery(r.name ?? String(r.mmsi));
    setOpen(false);
    onSelect(r);
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const showDropdown = open && query.trim().length > 0;

  return (
    <div ref={containerRef} style={{ position: "relative", width: 240 }}>
      {/* Input */}
      <div style={{
        display: "flex",
        alignItems: "center",
        background: "rgba(4, 12, 20, 0.92)",
        border: `1px solid ${focused ? "rgba(43,168,200,0.55)" : "rgba(43,168,200,0.2)"}`,
        borderRadius: 7,
        padding: "6px 10px",
        gap: 7,
        backdropFilter: "blur(8px)",
        transition: "border-color 0.15s",
      }}>
        <span style={{ fontSize: 13, color: "#5a8090", flexShrink: 0 }}>⌕</span>
        <input
          type="text"
          placeholder="Søg skib eller MMSI…"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => { setFocused(true); if (query) setOpen(true); }}
          onBlur={() => setFocused(false)}
          style={{
            background: "none",
            border: "none",
            outline: "none",
            color: "#c8dce8",
            fontSize: 12,
            fontFamily: "var(--font-mono, monospace)",
            width: "100%",
            caretColor: "#2ba8c8",
          }}
        />
        {loading && (
          <span style={{ fontSize: 10, color: "#5a8090", flexShrink: 0 }}>…</span>
        )}
        {query && !loading && (
          <button
            onClick={() => { setQuery(""); setResults([]); setOpen(false); }}
            style={{ background: "none", border: "none", color: "#5a8090", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1, flexShrink: 0 }}
          >×</button>
        )}
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div style={{
          position: "absolute",
          top: "calc(100% + 5px)",
          left: 0,
          right: 0,
          background: "rgba(4, 12, 20, 0.97)",
          border: "1px solid rgba(43,168,200,0.2)",
          borderRadius: 7,
          overflow: "hidden",
          zIndex: 50,
          backdropFilter: "blur(12px)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        }}>
          {results.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 11, color: "#5a8090", fontFamily: "monospace" }}>
              Ingen resultater
            </div>
          ) : (
            results.map((r) => (
              <div
                key={r.mmsi}
                onMouseDown={() => handleSelect(r)}
                style={{
                  padding: "9px 12px",
                  cursor: "pointer",
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(43,168,200,0.08)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {/* Historical badge */}
                {r.is_historical && (
                  <span style={{
                    fontSize: 9, color: "#f59e0b",
                    background: "rgba(245,158,11,0.12)",
                    border: "1px solid rgba(245,158,11,0.25)",
                    borderRadius: 3, padding: "1px 5px",
                    flexShrink: 0, letterSpacing: "0.04em",
                  }}>HIST</span>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#c8dce8", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.name || "Unknown"}
                  </div>
                  <div style={{ fontSize: 10, color: "#5a8090", fontFamily: "monospace", marginTop: 1 }}>
                    MMSI {r.mmsi}
                    {r.is_historical && r.last_t != null && (
                      <span style={{ marginLeft: 6, color: "#7a6030" }}>
                        · {new Date(r.last_t * 1000).getFullYear()}
                      </span>
                    )}
                  </div>
                </div>
                {r.is_historical ? (
                  <span style={{ fontSize: 9, color: "#f59e0b", flexShrink: 0 }}>⛵</span>
                ) : (
                  <span style={{ fontSize: 9, color: "#2ba8c8", flexShrink: 0 }}>▶</span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
