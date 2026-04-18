"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Props {
  minTime: number;
  maxTime: number;
  value: [number, number];
  onChange: (range: [number, number]) => void;
  onClose: () => void;
  bottom?: number;
  // Waypoint navigation
  waypoints?: number[];
  /** Speed (SOG, knots) parallel to `waypoints` — null where unknown */
  waypointSpeeds?: (number | null)[];
  /** prediction_color hex parallel to `waypoints` — matches line segment color; null where unknown */
  waypointColors?: (string | null)[];
  focusTime?: number | null;
  onFocusTimeChange?: (t: number) => void;
  // Independent visibility toggles
  showLine?: boolean;
  onShowLineChange?: (v: boolean) => void;
  showDots?: boolean;
  onShowDotsChange?: (v: boolean) => void;
  // Douglas toggle
  douglasMode?: boolean;
  onDouglasModeChange?: (v: boolean) => void;
  // Voyage: expand timeRange to full timeBounds
  onExpandToVoyage?: () => void;
  isVoyageView?: boolean;
  /** Cap the selectable window to this many ms (e.g. 24h for LINE mode) */
  maxSpanMs?: number;
  // Date range picker (for historical vessels — replaces VoyagePicker)
  showDatePicker?: boolean;
  onDateRangeLoad?: (startMs: number, endMs: number) => void;
  loading?: boolean;
  pointCount?: number | null;
  loadedRange?: [number, number] | null;
  // Panel mode
  panelMode?: "live" | "timemachine";
  onPanelModeChange?: (mode: "live" | "timemachine") => void;
  // Replay props (only used in timemachine mode)
  replay?: {
    dateStart: string;
    dateEnd: string;
    onDateStartChange: (v: string) => void;
    onDateEndChange: (v: string) => void;
    loading: boolean;
    onLoad: () => void;
    vesselCount: number | null;
    playing: boolean;
    onPlayToggle: () => void;
    speedIdx: number;
    speeds: number[];
    onSpeedChange: (idx: number) => void;
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────
function toDateStr(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtCompact(ms: number, span: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  if (span < 2 * 3600_000)   return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  if (span < 48 * 3600_000)  return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (span < 45 * 86400_000) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  if (span < 2 * 365 * 86400_000) return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}
// Full timestamp for handle-labels: altid dato + tid, uanset zoom.
const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
// Kompakt dato+tid til pille-labels: "17 apr · 14:29" — kort nok til at
// tre prikker kan stå tæt uden at overlappe, dansk format uden støj.
function fmtFull(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} · ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// Centreret label, men flipper mod venstre/højre kant så den aldrig klippes.
function anchorFor(pct: number): string {
  if (pct < 8)  return "0%";
  if (pct > 92) return "-100%";
  return "-50%";
}
// Lille pille-label der svæver over en handle: dato + tid i system-sans
// med diskret glasbaggrund, så den ikke skriger og ikke føles som en datadump.
function handleLabelStyle(color: string): React.CSSProperties {
  return {
    position: "absolute", bottom: 0,
    fontSize: 10,
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
    fontWeight: 500,
    color, opacity: 0.95,
    whiteSpace: "nowrap", pointerEvents: "none",
    letterSpacing: "0.01em",
    padding: "1px 7px",
    borderRadius: 999,
    background: "rgba(12, 17, 30, 0.7)",
    border: `1px solid ${color}33`,
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
  };
}
// Fælles styling for de runde prik-knapper (både TIMESTRIP-handles og MOMENT).
function handleKnobStyle(color: string, _glow: string): React.CSSProperties {
  // Ingen farvet glow — bare en ren cirkel med diskret skygge for dybde.
  // Giver et renere, "normalt" slider-look i stedet for den cyan halo.
  return {
    width: 16, height: 16, borderRadius: "50%",
    background: color,
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 0, 0, 0.25)",
    pointerEvents: "none",
  };
}

const STEP = 60_000;

// ─── Glass design tokens ──────────────────────────────────────────────────
const G = {
  bg:        "rgba(12, 17, 30, 0.58)",
  inner:     "rgba(255, 255, 255, 0.04)",
  border:    "rgba(255, 255, 255, 0.10)",
  borderHi:  "rgba(255, 255, 255, 0.18)",
  highlight: "rgba(255, 255, 255, 0.08)",
  shadow:    "0 20px 56px rgba(0, 0, 0, 0.50), 0 6px 18px rgba(0, 0, 0, 0.32)",
  text:  "rgba(255, 255, 255, 0.94)",
  dim:   "rgba(255, 255, 255, 0.68)",
  muted: "rgba(255, 255, 255, 0.42)",
  faint: "rgba(255, 255, 255, 0.18)",
  // Øverste slider = tid-range. Hvid/neutral — den skal ikke skrige, den er
  // bare "hvor står jeg i historien". Farve-accenten (orange MOMENT + grøn
  // LIVE) bærer betydningen.
  aqua:     "#FFFFFF",
  aquaSoft: "rgba(255, 255, 255, 0.28)",
  aquaBg:   "rgba(255, 255, 255, 0.10)",
  aquaDim:  "rgba(255, 255, 255, 0.42)",
  aquaGlow: "rgba(255, 255, 255, 0.22)",
  // Orange slider = MOMENT (playhead). Varm orange, tydelig modpol til blå.
  accent:     "#F97316",
  accentBg:   "rgba(249, 115, 22, 0.18)",
  accentSoft: "rgba(249, 115, 22, 0.30)",
  accentGlow: "rgba(249, 115, 22, 0.28)",
  live:       "#6EE7B7",
};

const ZOOM_PRESETS: { label: string; span: number | "all" }[] = [
  { label: "1h",  span: 3_600_000 },
  { label: "6h",  span: 21_600_000 },
  { label: "1d",  span: 86_400_000 },
  { label: "7d",  span: 604_800_000 },
  { label: "30d", span: 2_592_000_000 },
  { label: "All", span: "all" },
];

function snapToNearest(t: number, waypoints: number[]): number {
  if (!waypoints.length) return t;
  return waypoints.reduce((best, wp) => Math.abs(wp - t) < Math.abs(best - t) ? wp : best);
}

function binWaypoints(waypoints: number[] | undefined, from: number, to: number, n: number): number[] {
  const out = new Array(n).fill(0);
  if (!waypoints || !waypoints.length || to <= from) return out;
  const span = to - from;
  for (const t of waypoints) {
    if (t < from || t > to) continue;
    const idx = Math.min(n - 1, Math.max(0, Math.floor(((t - from) / span) * n)));
    out[idx]++;
  }
  return out;
}

/**
 * Bin waypoints by MAX SPEED per bucket. Used for the histogram bars:
 * tall bar = vessel moving fast, short bar = slow/stopped, gap = no data.
 * Provides a meaningful visual rhythm of the voyage (harbour vs open sea)
 * and keeps working with D·P compressed tracks (speed persists per segment).
 */
function binSpeeds(
  waypoints: number[] | undefined,
  speeds: (number | null)[] | undefined,
  from: number, to: number, n: number,
): { value: number; count: number }[] {
  const out = Array.from({ length: n }, () => ({ value: 0, count: 0 }));
  if (!waypoints || !waypoints.length || to <= from) return out;
  const span = to - from;
  for (let i = 0; i < waypoints.length; i++) {
    const t = waypoints[i];
    if (t < from || t > to) continue;
    const idx = Math.min(n - 1, Math.max(0, Math.floor(((t - from) / span) * n)));
    const s = speeds?.[i];
    if (s != null && isFinite(s) && s > out[idx].value) out[idx].value = s;
    out[idx].count++;
  }
  return out;
}

/**
 * Rank prediction colors by "badness" (higher = more anomalous).
 * Matches the LINE-mode palette from trackRules.ts:
 *   0 = unknown / gap-grey
 *   1 = green  (#00e676) — good prediction
 *   2 = yellow (#ffeb3b) — small drift
 *   3 = orange (#ff9800) — noticeable drift
 *   4 = red    (#f44336) — large anomaly
 */
function colorRank(c: string | null | undefined): number {
  if (!c) return 0;
  const lower = c.toLowerCase();
  if (lower.startsWith("#f4") || lower.startsWith("#f44")) return 4; // red
  if (lower.startsWith("#ff9"))                             return 3; // orange
  if (lower.startsWith("#ffe") || lower.startsWith("#ffeb")) return 2; // yellow
  if (lower.startsWith("#00"))                              return 1; // green
  return 0;
}

/**
 * Bin the "worst" (highest-rank) prediction_color per bucket.
 * Buckets with no waypoints stay null (caller decides how to render).
 */
function binWorstColor(
  waypoints: number[] | undefined,
  colors: (string | null)[] | undefined,
  from: number, to: number, n: number,
): (string | null)[] {
  const out: (string | null)[] = new Array(n).fill(null);
  if (!waypoints || !waypoints.length || !colors || to <= from) return out;
  const span = to - from;
  const bestRank = new Array(n).fill(-1);
  for (let i = 0; i < waypoints.length; i++) {
    const t = waypoints[i];
    if (t < from || t > to) continue;
    const idx = Math.min(n - 1, Math.max(0, Math.floor(((t - from) / span) * n)));
    const c = colors[i];
    const r = colorRank(c);
    if (r > bestRank[idx]) {
      bestRank[idx] = r;
      out[idx] = c ?? null;
    }
  }
  return out;
}

/**
 * Bin gap-severity per bucket — mirrors TrackLayer's gap detection.
 * For each bucket we look at the LARGEST time delta (dtSec) between
 * consecutive waypoints that either starts or ends inside the bucket.
 *
 *   0 = no gap (solid line)
 *   1 = SHORT gap (dense dashed, 5-10 min)
 *   2 = LONG  gap (sparse dashed, 10-20 min)
 *   3 = broken (> 20 min — new track break; treated like LONG for bar)
 *
 * Uses the same thresholds as trackRules.ts → GAP.
 */
const GAP_LOWER_SEC = 300;         // 5 min
const GAP_SHORT_UPPER_SEC = 600;   // 10 min
const GAP_LONG_SEC = 1200;         // 20 min
function binGaps(
  waypoints: number[] | undefined,
  from: number, to: number, n: number,
): number[] {
  const out = new Array(n).fill(0);
  if (!waypoints || waypoints.length < 2 || to <= from) return out;
  const span = to - from;
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    if (b < from || a > to) continue;
    const dtSec = (b - a) / 1000;
    if (dtSec <= GAP_LOWER_SEC) continue;
    let sev = 1;
    if (dtSec > GAP_SHORT_UPPER_SEC && dtSec <= GAP_LONG_SEC) sev = 2;
    else if (dtSec > GAP_LONG_SEC)                             sev = 3;
    // Mark every bucket STRICTLY between the two gap-endpoints — the silent
    // interval. We skip the waypoint's own bucket so its prediction-colored
    // bar isn't visually "stretched" by the gap's minimum height.
    const startIdx = Math.min(n - 1, Math.max(0, Math.floor(((a - from) / span) * n)));
    const endIdx   = Math.min(n - 1, Math.max(0, Math.floor(((b - from) / span) * n)));
    for (let k = startIdx + 1; k < endIdx; k++) {
      if (sev > out[k]) out[k] = sev;
    }
  }
  return out;
}

// ─── Shared histogram renderer ────────────────────────────────────────────
// Bruges både i TIMESTRIP (variant="mini") og MOMENT (variant="frame") —
// forskellene ligger i fart-farvetrapper og gap-intensitet.
type BarVariant = "mini" | "frame";

function HistogramBars({
  bins, gapBins, colorBins,
  max, hasSpeeds, hasColors, showLine,
  variant,
}: {
  bins: number[];
  gapBins: number[];
  colorBins: (string | null)[];
  max: number;
  hasSpeeds: boolean;
  hasColors: boolean;
  showLine: boolean;
  variant: BarVariant;
}) {
  // Tynd slider-strip: alle bins fylder fuld højde af track'en. Ingen
  // variabel højde — al information ligger nu i farven (fart, gap,
  // prediction-farve). Tomme bins og "break" (>20 min uden waypoints)
  // vises som transparent segment, så sporet får synlige sprækker der
  // hvor der faktisk mangler data.
  const MINI = variant === "mini";
  return (
    <div style={{
      position: "absolute", inset: 0,
      display: "flex", alignItems: "stretch",
      gap: 0, pointerEvents: "none",
    }}>
      {bins.map((v, i) => {
        const ratio = v / max;
        let bg: string;
        let op: number;
        if (MINI) {
          // TIMESTRIP — binær, med kraftig fade på stilstand.
          const moving = hasSpeeds ? v > 0.05 : v > 0;
          bg = moving ? G.aquaDim : G.faint;
          op = moving ? 0.85 : 0.35;
        } else {
          // MOMENT — 3-trins fart-farve, fuld opacitet.
          op = 1;
          if (hasSpeeds) {
            if (v < 0.1)        bg = G.faint;
            else if (v < 0.35)  bg = G.aquaDim;
            else                bg = G.aqua;
          } else {
            bg = ratio > 0.7 ? G.aqua : G.aquaDim;
          }
        }
        // Gap-farver: match map-renderingen — dashed grå for 5-20 min.
        const g = gapBins[i];
        let isBreak = false;
        if (g === 1) {
          bg = "#a3b1c2"; op = MINI ? 0.65 : 0.85;
        } else if (g === 2) {
          bg = "#c8d2de"; op = MINI ? 0.55 : 0.7;
        } else if (g === 3 && v === 0) {
          // Break (>20 min, ingen forbindelseslinje på kort) → transparent.
          isBreak = true;
        }
        // LINE-mode: prediction-farve pr. bin overruler aqua/gap-grå —
        // men KUN i MOMENT. TIMESTRIP er en oversigt over "her er der
        // data", ikke en kvalitetsvisning, så vi holder den aqua/grå.
        if (!MINI && showLine && hasColors && v > 0) {
          const c = colorBins[i];
          if (c) { bg = c; op = 1; }
        }
        // Tom bin (ingen waypoint, ingen gap) eller break → gennemsigtig.
        if (isBreak || (v === 0 && g === 0)) {
          return <div key={i} style={{ flex: 1, background: "transparent" }} />;
        }
        return (
          <div key={i} style={{
            flex: 1,
            background: bg,
            opacity: op,
          }} />
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
export default function TimeSlider({
  minTime, maxTime, value, onChange, onClose, bottom = 20,
  waypoints, waypointSpeeds, waypointColors, focusTime, onFocusTimeChange,
  onExpandToVoyage, isVoyageView, maxSpanMs,
  showDatePicker, onDateRangeLoad, loading, pointCount, loadedRange,
  douglasMode, onDouglasModeChange,
  showLine = true, onShowLineChange,
  showDots = false, onShowDotsChange,
  panelMode = "live", onPanelModeChange,
  replay,
}: Props) {
  const [studioOpen, setStudioOpen] = useState(false);

  // ── Historical date-picker local state ────────────────────────────────
  // Derive default date strings directly from min/maxTime, with a user-edit
  // override. This replaces the previous useEffect(setState, [minTime,maxTime])
  // pattern (setState-in-effect) that caused an extra render cycle.
  const [dateOverride, setDateOverride] = useState<{ start: string; end: string } | null>(null);
  const defaultDateStart = toDateStr(new Date(minTime));
  const defaultDateEnd   = toDateStr(new Date(maxTime));
  // If the default bounds change (new vessel / new replay window), drop the
  // user's override so the picker reflects the fresh range.
  const lastBoundsRef = useRef<{ start: string; end: string }>({ start: defaultDateStart, end: defaultDateEnd });
  if (lastBoundsRef.current.start !== defaultDateStart || lastBoundsRef.current.end !== defaultDateEnd) {
    lastBoundsRef.current = { start: defaultDateStart, end: defaultDateEnd };
    if (dateOverride) setDateOverride(null);
  }
  const dateStart = dateOverride?.start ?? defaultDateStart;
  const dateEnd   = dateOverride?.end   ?? defaultDateEnd;
  const setDateStart = (s: string) => setDateOverride({ start: s, end: dateEnd });
  const setDateEnd   = (e: string) => setDateOverride({ start: dateStart, end: e });
  const handleDateLoad = useCallback(() => {
    if (!onDateRangeLoad) return;
    const s = new Date(dateStart + "T00:00:00Z").getTime();
    const e = new Date(dateEnd + "T23:59:59Z").getTime();
    if (isNaN(s) || isNaN(e) || e <= s) return;
    onDateRangeLoad(s, e);
  }, [dateStart, dateEnd, onDateRangeLoad]);

  const span   = Math.max(1, maxTime - minTime);
  const vpSpan = Math.max(1, value[1] - value[0]);

  const vpStartPct = ((value[0] - minTime) / span) * 100;
  const vpEndPct   = ((value[1] - minTime) / span) * 100;

  const focusInRange = focusTime != null && focusTime >= value[0] && focusTime <= value[1];
  const focusFramePct = focusInRange ? ((focusTime! - value[0]) / vpSpan) * 100 : null;

  // MOMENT-knappen er altid orange — dens formål er at være tydelig. Gap-
  // information aflæses fra histogrammet under/omkring knappen, ikke fra
  // knappens egen farve.
  const playheadColor = G.accent;
  const playheadGlow  = G.accentGlow;

  // ── Refs ──────────────────────────────────────────────────────────────
  const miniRef  = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const miniDrag = useRef<"start" | "end" | "pan" | null>(null);
  const panStart = useRef<{ x: number; vp0: number; vp1: number } | null>(null);
  // Gem cursor-offset relativt til handle-kant ved pointerdown, så dragget er
  // relativt i stedet for absolut. Uden dette "hopper" handlen 0–6px ved første
  // move, afhængig af hvor i den 12px brede hit-area du ramte.
  const handleStart = useRef<{ x: number; t0: number; t1: number } | null>(null);
  const frameDrag = useRef<boolean>(false);

  // ── Zoom chip logic ───────────────────────────────────────────────────
  const applyZoom = useCallback((targetSpan: number | "all") => {
    if (targetSpan === "all") { onChange([minTime, maxTime]); return; }
    let newSpan = Math.min(targetSpan, span);
    if (maxSpanMs) newSpan = Math.min(newSpan, maxSpanMs);
    const center = focusInRange ? (focusTime as number) : (value[0] + value[1]) / 2;
    let newStart = Math.round((center - newSpan / 2) / STEP) * STEP;
    let newEnd   = newStart + newSpan;
    if (newStart < minTime) { newStart = minTime; newEnd = newStart + newSpan; }
    if (newEnd   > maxTime) { newEnd   = maxTime; newStart = newEnd - newSpan; }
    onChange([Math.max(minTime, newStart), Math.min(maxTime, newEnd)]);
  }, [onChange, minTime, maxTime, span, maxSpanMs, focusInRange, focusTime, value]);

  const activeChip = useMemo(() => {
    if (Math.abs(vpSpan - span) < 60_000 && vpStartPct < 0.5 && vpEndPct > 99.5) return "all";
    let best: number | null = null;
    let bestDelta = Infinity;
    for (const p of ZOOM_PRESETS) {
      if (p.span === "all") continue;
      const d = Math.abs((p.span as number) - vpSpan);
      if (d < bestDelta && d < 120_000) { bestDelta = d; best = p.span as number; }
    }
    return best;
  }, [vpSpan, span, vpStartPct, vpEndPct]);

  // ── Pointer helpers ───────────────────────────────────────────────────
  const timeFromFrameX = useCallback((clientX: number) => {
    const rect = frameRef.current!.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round((value[0] + pct * vpSpan) / STEP) * STEP;
  }, [value, vpSpan]);

  // ── Mini interaction ──────────────────────────────────────────────────
  const onMiniDown = useCallback((e: React.PointerEvent<HTMLDivElement>, kind: "start" | "end" | "pan") => {
    miniDrag.current = kind;
    if (kind === "pan") panStart.current = { x: e.clientX, vp0: value[0], vp1: value[1] };
    // Snapshot af cursor-x + viewport-kanter ved drag-start → relativt drag.
    handleStart.current = { x: e.clientX, t0: value[0], t1: value[1] };
    try { (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
    e.stopPropagation();
    e.preventDefault();
  }, [value]);

  const onMiniMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!miniDrag.current) return;
    // Self-heal dangling drag: hvis ingen knap er trykket, var pointerup tabt.
    // Ryd state og bail, ellers "klæber" handlen sig til musen på hover.
    if (e.buttons === 0) {
      miniDrag.current = null;
      panStart.current = null;
      handleStart.current = null;
      return;
    }
    if (miniDrag.current === "pan" && panStart.current) {
      const rect = miniRef.current!.getBoundingClientRect();
      const dx   = e.clientX - panStart.current.x;
      const dms  = (dx / rect.width) * span;
      const width = panStart.current.vp1 - panStart.current.vp0;
      let newStart = panStart.current.vp0 + dms;
      if (newStart < minTime) newStart = minTime;
      if (newStart + width > maxTime) newStart = maxTime - width;
      newStart = Math.round(newStart / STEP) * STEP;
      onChange([newStart, newStart + width]);
      return;
    }
    // Relativt drag: oversæt dx siden pointerdown til tids-delta.
    // Fjerner 0–6px "hop" på første move.
    if (!handleStart.current || !miniRef.current) return;
    const rect = miniRef.current.getBoundingClientRect();
    const dx = e.clientX - handleStart.current.x;
    const dms = (dx / rect.width) * span;
    if (miniDrag.current === "start") {
      let newStart = handleStart.current.t0 + dms;
      newStart = Math.round(newStart / STEP) * STEP;
      newStart = Math.min(newStart, handleStart.current.t1 - STEP);
      if (maxSpanMs) newStart = Math.max(newStart, handleStart.current.t1 - maxSpanMs);
      if (newStart < minTime) newStart = minTime;
      onChange([newStart, handleStart.current.t1]);
      if (focusTime != null && focusTime < newStart && onFocusTimeChange) {
        const inRange = waypoints?.filter((w) => w >= newStart && w <= handleStart.current!.t1) ?? [];
        if (inRange.length) onFocusTimeChange(snapToNearest(newStart, inRange));
      }
    } else if (miniDrag.current === "end") {
      let newEnd = handleStart.current.t1 + dms;
      newEnd = Math.round(newEnd / STEP) * STEP;
      newEnd = Math.max(newEnd, handleStart.current.t0 + STEP);
      if (maxSpanMs) newEnd = Math.min(newEnd, handleStart.current.t0 + maxSpanMs);
      if (newEnd > maxTime) newEnd = maxTime;
      onChange([handleStart.current.t0, newEnd]);
      if (focusTime != null && focusTime > newEnd && onFocusTimeChange) {
        const inRange = waypoints?.filter((w) => w >= handleStart.current!.t0 && w <= newEnd) ?? [];
        if (inRange.length) onFocusTimeChange(snapToNearest(newEnd, inRange));
      }
    }
  }, [onChange, focusTime, onFocusTimeChange, waypoints, maxSpanMs, minTime, maxTime, span]);

  const onMiniUp = useCallback(() => {
    miniDrag.current = null;
    panStart.current = null;
    handleStart.current = null;
  }, []);

  // ── Safety net: altid ryd drag-state når musen slippes eller vinduet mister
  //    fokus. Fanger "dangling drag" hvor pointerup missede elementet (fx
  //    hvis pointer-capture hang fast eller musen forlod viewport). Uden
  //    denne ryd-op klæber handle/viewport sig til musen på næste hover.
  useEffect(() => {
    const clear = () => {
      miniDrag.current = null;
      panStart.current = null;
      handleStart.current = null;
      frameDrag.current = false;
    };
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // ── Frame interaction (move playhead) ────────────────────────────────
  const onFrameDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!onFocusTimeChange) return;
    frameDrag.current = true;
    onFocusTimeChange(timeFromFrameX(e.clientX));
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, [timeFromFrameX, onFocusTimeChange]);
  const onFrameMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!frameDrag.current || !onFocusTimeChange) return;
    if (e.buttons === 0) { frameDrag.current = false; return; }
    onFocusTimeChange(timeFromFrameX(e.clientX));
  }, [timeFromFrameX, onFocusTimeChange]);
  const onFrameUp = useCallback(() => { frameDrag.current = false; }, []);

  // ── Histograms (bars = max SPEED per bucket; falls back to density when no speed data) ──
  const hasSpeeds = !!waypointSpeeds?.some((s) => s != null);
  const hasColors = !!waypointColors?.some((c) => c != null);
  const miniSpeedBins  = useMemo(() => binSpeeds(waypoints, waypointSpeeds, minTime, maxTime, 60),  [waypoints, waypointSpeeds, minTime, maxTime]);
  const frameSpeedBins = useMemo(() => binSpeeds(waypoints, waypointSpeeds, value[0], value[1], 120), [waypoints, waypointSpeeds, value]);
  const miniCountBins  = useMemo(() => binWaypoints(waypoints, minTime, maxTime, 60), [waypoints, minTime, maxTime]);
  const frameCountBins = useMemo(() => binWaypoints(waypoints, value[0], value[1], 120), [waypoints, value]);
  const miniColorBins  = useMemo(() => binWorstColor(waypoints, waypointColors, minTime, maxTime, 60),  [waypoints, waypointColors, minTime, maxTime]);
  const frameColorBins = useMemo(() => binWorstColor(waypoints, waypointColors, value[0], value[1], 120), [waypoints, waypointColors, value]);
  const miniGapBins    = useMemo(() => binGaps(waypoints, minTime, maxTime, 60),  [waypoints, minTime, maxTime]);
  const frameGapBins   = useMemo(() => binGaps(waypoints, value[0], value[1], 120), [waypoints, value]);

  // Cap at 20 kn for scaling — beyond that is an outlier and we still want visible detail below.
  const SPEED_CAP = 20;
  const miniBins  = hasSpeeds
    ? miniSpeedBins.map((b)  => b.count === 0 ? 0 : Math.min(1, b.value / SPEED_CAP))
    : miniCountBins;
  const frameBins = hasSpeeds
    ? frameSpeedBins.map((b) => b.count === 0 ? 0 : Math.min(1, b.value / SPEED_CAP))
    : frameCountBins;
  const miniMax   = hasSpeeds ? 1 : Math.max(1, ...(miniBins as number[]));
  const frameMax  = hasSpeeds ? 1 : Math.max(1, ...(frameBins as number[]));

  const W = "min(960px, calc(100vw - 32px))";

  return (
    <div
      style={{
        position: "absolute",
        bottom,
        left: "50%",
        transform: "translateX(-50%)",
        width: W,
        background: G.bg,
        backdropFilter: "blur(22px) saturate(1.4)",
        WebkitBackdropFilter: "blur(22px) saturate(1.4)",
        border: `1px solid ${G.border}`,
        borderRadius: 16,
        zIndex: 20,
        fontFamily: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
        userSelect: "none",
        boxShadow: G.shadow,
        color: G.text,
        overflow: "hidden",
      }}
    >
      <div aria-hidden style={{
        position: "absolute", left: 1, right: 1, top: 0, height: 1,
        background: `linear-gradient(90deg, transparent, ${G.highlight}, transparent)`,
        pointerEvents: "none",
      }} />

      {/* ─── ROW 1: mode + layers + readout + close ──────────── */}
      <div style={{
        padding: "8px 12px",
        display: "flex", alignItems: "center", gap: 8,
        flexWrap: "wrap",
      }}>
        {onPanelModeChange && (
          <Segment
            options={[
              { value: "live",        label: "LIVE",        glyph: "●", glyphColor: G.live },
              { value: "timemachine", label: "TIME MACHINE", glyph: "⏱", glyphColor: G.accent },
            ]}
            value={panelMode}
            onChange={(v) => onPanelModeChange(v as "live" | "timemachine")}
          />
        )}
        <div style={{ display: "flex", gap: 3, alignItems: "center", flexWrap: "wrap" }}>
          {onShowLineChange && (
            <GlassChip small active={showLine} color={G.aqua} onClick={() => onShowLineChange(!showLine)} title="Farvegradieret linje">LINE</GlassChip>
          )}
          {onShowDotsChange && (
            <GlassChip small active={showDots} color={G.aqua} onClick={() => onShowDotsChange(!showDots)} title="AIS-waypoints">WP</GlassChip>
          )}
          {onDouglasModeChange && (
            <GlassChip small active={!!douglasMode} color={G.accent} onClick={() => onDouglasModeChange(!douglasMode)} title="Douglas-Peucker komprimeret track">D·P</GlassChip>
          )}
          {onExpandToVoyage && (
            <GlassChip small active={!!isVoyageView} color={G.accent} onClick={onExpandToVoyage} title="Hele rejsen">VOYAGE ↗</GlassChip>
          )}
        </div>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11, color: G.aqua, letterSpacing: "-0.005em",
          marginLeft: 4,
        }}>
          {fmtCompact(value[0], vpSpan)} → {fmtCompact(value[1], vpSpan)}
        </span>

        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
          {ZOOM_PRESETS.map((p) => {
            const disabled = p.span !== "all" && maxSpanMs != null && (p.span as number) > maxSpanMs;
            const active = (p.span === "all" && activeChip === "all") || activeChip === p.span;
            return (
              <GlassChip
                key={p.label}
                small
                active={active}
                color={G.aqua}
                disabled={disabled}
                onClick={() => !disabled && applyZoom(p.span)}
              >
                {p.label}
              </GlassChip>
            );
          })}
        </div>

        <button
          onClick={() => setStudioOpen((v) => !v)}
          aria-expanded={studioOpen}
          aria-label="Toggle Studio"
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            background: studioOpen ? G.highlight : G.inner,
            border: `1px solid ${studioOpen ? G.borderHi : G.border}`,
            color: G.text, padding: "3px 9px", borderRadius: 7,
            fontFamily: "inherit", fontSize: 11, fontWeight: 500,
            cursor: "pointer", transition: "all 160ms", height: 24,
          }}
        >
          Studio
          <span style={{
            fontSize: 9, color: G.muted,
            transform: studioOpen ? "rotate(180deg)" : "none",
            transition: "transform 150ms",
          }}>▾</span>
        </button>

        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            background: "transparent",
            border: `1px solid ${G.border}`,
            color: G.muted, cursor: "pointer",
            width: 24, height: 24, borderRadius: 7, fontSize: 12, padding: 0,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontFamily: "inherit", transition: "all 160ms",
          }}
          onMouseEnter={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.color = G.text; el.style.borderColor = G.borderHi; }}
          onMouseLeave={(e) => { const el = e.currentTarget as HTMLButtonElement; el.style.color = G.muted; el.style.borderColor = G.border; }}
        >✕</button>
      </div>

      {/* ─── Replay dates (TIME MACHINE only) ─────────────────── */}
      {panelMode === "timemachine" && replay && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 12px 8px",
            borderTop: `1px solid ${G.border}`,
            flexWrap: "wrap",
          }}
        >
          <input type="date" value={replay.dateStart} onChange={(e) => replay.onDateStartChange(e.target.value)} onClick={(e) => e.stopPropagation()} style={glassInputStyle} />
          <span style={{ fontSize: 10, color: G.muted }}>→</span>
          <input type="date" value={replay.dateEnd} min={replay.dateStart} max="2100-12-31" onChange={(e) => replay.onDateEndChange(e.target.value)} onClick={(e) => e.stopPropagation()} style={glassInputStyle} />
          <GlassButton small onClick={replay.onLoad} disabled={replay.loading} color={G.aqua}>
            {replay.loading ? "…" : "LOAD"}
          </GlassButton>
          <div style={{ flex: 1 }} />
          {replay.vesselCount != null && (
            <span style={{ fontSize: 10, color: G.muted, fontFamily: "'JetBrains Mono', monospace" }}>
              {replay.vesselCount} vessels
            </span>
          )}
        </div>
      )}

      {/* ─── Historical date picker ─────────────────────────── */}
      {showDatePicker && onDateRangeLoad && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 12px 8px",
            borderTop: `1px solid ${G.border}`,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 10, color: G.accent, letterSpacing: "0.1em", fontWeight: 600 }}>⛵ VOYAGE</span>
          <input type="date" value={dateStart} min="1800-01-01" max="2100-12-31" onChange={(e) => setDateStart(e.target.value)} onClick={(e) => e.stopPropagation()} style={glassInputStyle} />
          <span style={{ fontSize: 10, color: G.muted }}>→</span>
          <input type="date" value={dateEnd} min={dateStart} max="2100-12-31" onChange={(e) => setDateEnd(e.target.value)} onClick={(e) => e.stopPropagation()} style={glassInputStyle} />
          <GlassButton small onClick={handleDateLoad} disabled={!!loading} color={G.aqua}>
            {loading ? "…" : "LOAD"}
          </GlassButton>
          <div style={{ flex: 1 }} />
          {pointCount != null && loadedRange && (
            <span style={{ fontSize: 10, color: G.muted, fontFamily: "'JetBrains Mono', monospace" }}>
              {pointCount} pts
            </span>
          )}
        </div>
      )}

      {/* ─── BODY: timestrip + frame ─────────────────────────── */}
      <div style={{ padding: "8px 12px 12px" }}>

        {/* Handle-labels: kompakte dato+tid-piller der følger handles. */}
        <div style={{ position: "relative", height: 18, marginBottom: 4 }}>
          <span style={{ ...handleLabelStyle(G.aqua), left: `${vpStartPct}%`, transform: `translateX(${anchorFor(vpStartPct)})` }}>
            {fmtFull(value[0])}
          </span>
          <span style={{ ...handleLabelStyle(G.aqua), left: `${vpEndPct}%`, transform: `translateX(${anchorFor(vpEndPct)})` }}>
            {fmtFull(value[1])}
          </span>
        </div>

        {/* TIMESTRIP track (tynd) — hit-area er højere end track så
            handles stadig er nemme at ramme. Track'en sidder centreret i
            den 22px-høje wrapper; knobs floater ovenpå. */}
        <div style={{
          position: "relative",
          height: 22,
          display: "flex",
          alignItems: "center",
        }}>
          <div
            ref={miniRef}
            style={{
              position: "relative",
              width: "100%",
              height: 6,
              background: G.inner,
              border: `1px solid ${G.border}`,
              borderRadius: 999,
              overflow: "hidden",
              touchAction: "none",
            }}
          >
            <HistogramBars
              variant="mini"
              bins={miniBins}
              gapBins={miniGapBins}
              colorBins={miniColorBins}
              max={miniMax}
              hasSpeeds={hasSpeeds}
              hasColors={hasColors}
              showLine={!!showLine}
            />
            {/* VIEWPORT-fyld — aqua tint mellem de to handles. Ingen kant-
                border, for prikkerne selv markerer grænserne. Pointer-
                transparent så klik/drag falder igennem til outer scrub. */}
            <div style={{
              position: "absolute", top: 0, bottom: 0,
              left: `${vpStartPct}%`,
              width: `${Math.max(0.3, vpEndPct - vpStartPct)}%`,
              background: G.aquaBg,
              pointerEvents: "none",
            }} />
          </div>
          {/* MOMENT mini-prik — lever inde i TIMESTRIP-wrapperen, centreret
              på baren. Z-index under de blå handles så de altid vinder hvis
              de overlapper. */}
          {focusTime != null && (() => {
            const focusMiniPct = ((focusTime - minTime) / span) * 100;
            if (focusMiniPct < 0 || focusMiniPct > 100) return null;
            return (
              <div style={{
                position: "absolute",
                top: "50%",
                left: `${focusMiniPct}%`,
                transform: "translate(-50%, -50%)",
                width: 10, height: 10, borderRadius: "50%",
                background: G.accent,
                boxShadow: "0 1px 2px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 0, 0, 0.25)",
                pointerEvents: "none",
                zIndex: 1,
              }} />
            );
          })()}
          {/* Resize-handles som runde blå prikker. Hit-area er 28×22px
              centreret om track'en så den er nem at ramme trods tynd bar. */}
          {([
            { kind: "start" as const, pct: vpStartPct },
            { kind: "end"   as const, pct: vpEndPct   },
          ]).map((h) => (
            <div
              key={h.kind}
              onPointerDown={(e) => onMiniDown(e, h.kind)}
              onPointerMove={onMiniMove}
              onPointerUp={onMiniUp}
              onPointerCancel={onMiniUp}
              style={{
                position: "absolute",
                top: 0, bottom: 0,
                left: `calc(${h.pct}% - 14px)`,
                width: 28, cursor: "ew-resize", touchAction: "none",
                display: "flex", alignItems: "center", justifyContent: "center",
                zIndex: 2,
              }}
            >
              <div style={handleKnobStyle(G.aqua, G.aquaGlow)} />
            </div>
          ))}
        </div>

        {/* Handle-label: kompakt dato+tid-pille der følger MOMENT-knappen. */}
        <div style={{ position: "relative", height: 18, marginTop: 10, marginBottom: 4 }}>
          {focusTime != null && focusFramePct != null && (
            <span style={{
              ...handleLabelStyle(playheadColor),
              left: `${focusFramePct}%`,
              transform: `translateX(${anchorFor(focusFramePct)})`,
            }}>{fmtFull(focusTime)}</span>
          )}
        </div>

        {/* MOMENT track (tynd, identisk design som TIMESTRIP). Hit-area
            (22px) er på wrapper-niveau så knobben kan floate ovenpå. */}
        <div style={{
          position: "relative",
          height: 22,
          display: "flex",
          alignItems: "center",
        }}>
          <div
            ref={frameRef}
            onPointerDown={onFrameDown}
            onPointerMove={onFrameMove}
            onPointerUp={onFrameUp}
            onPointerCancel={onFrameUp}
            style={{
              position: "relative",
              width: "100%",
              height: 6,
              background: G.inner,
              border: `1px solid ${G.border}`,
              borderRadius: 999,
              cursor: onFocusTimeChange ? "ew-resize" : "default",
              overflow: "hidden",
              touchAction: "none",
            }}
          >
            <HistogramBars
              variant="frame"
              bins={frameBins}
              gapBins={frameGapBins}
              colorBins={frameColorBins}
              max={frameMax}
              hasSpeeds={hasSpeeds}
              hasColors={hasColors}
              showLine={!!showLine}
            />
          </div>
          {/* playhead — rund orange knap man hiver i. Samme størrelse som
              TIMESTRIP-handlene. Klik/drag falder igennem til frameRef. */}
          {focusFramePct != null && (
            <div style={{
              position: "absolute",
              top: "50%",
              left: `${focusFramePct}%`,
              transform: "translate(-50%, -50%)",
              zIndex: 3,
              ...handleKnobStyle(playheadColor, playheadGlow),
            }} />
          )}
        </div>

        {/* ─── STUDIO (open on demand; play/speed/jump live here) ── */}
        {studioOpen && (
          <div style={{
            marginTop: 8,
            background: G.inner,
            border: `1px solid ${G.border}`,
            borderRadius: 10,
            padding: "10px 12px",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            {replay && panelMode === "timemachine" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ ...sectionLabelStyle, width: 56 }}>PLAY</span>
                <GlassButton small onClick={replay.onPlayToggle} color={G.accent} primary>
                  {replay.playing ? "⏸ Pause" : "▶ Play"}
                </GlassButton>
                <span style={{ width: 10 }} />
                <span style={{ ...sectionLabelStyle }}>SPEED</span>
                {replay.speeds.map((s, idx) => (
                  <GlassChip
                    key={s} small
                    active={idx === replay.speedIdx}
                    color={G.accent}
                    onClick={() => replay.onSpeedChange(idx)}
                  >
                    {s}×
                  </GlassChip>
                ))}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ ...sectionLabelStyle, width: 56 }}>JUMP</span>
              <GlassButton small onClick={() => onFocusTimeChange?.(value[0])} color={G.accent}>⇤ Start</GlassButton>
              <GlassButton small onClick={() => onFocusTimeChange?.(value[1])} color={G.accent}>End ⇥</GlassButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Small internal components
// ════════════════════════════════════════════════════════════════════════

function Segment({ options, value, onChange }: {
  options: { value: string; label: string; glyph?: string; glyphColor?: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    const btn = refs.current[value];
    const container = containerRef.current;
    if (!btn || !container) return;
    const bR = btn.getBoundingClientRect();
    const cR = container.getBoundingClientRect();
    setThumb({ left: bR.left - cR.left, width: bR.width });
  }, [value, options.length]);

  return (
    <div
      ref={containerRef}
      role="tablist"
      style={{
        position: "relative",
        display: "inline-flex",
        padding: 3,
        background: "rgba(255,255,255,0.06)",
        borderRadius: 10,
        border: `1px solid ${G.border}`,
      }}
    >
      {thumb && (
        <div aria-hidden style={{
          position: "absolute", top: 3, bottom: 3,
          left: thumb.left, width: thumb.width,
          background: "rgba(255,255,255,0.10)",
          backdropFilter: "blur(10px)",
          borderRadius: 7,
          border: `1px solid ${G.borderHi}`,
          transition: "left 240ms cubic-bezier(.4,0,.2,1), width 240ms cubic-bezier(.4,0,.2,1)",
          zIndex: 0,
        }} />
      )}
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => { refs.current[opt.value] = el; }}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            style={{
              position: "relative", zIndex: 1,
              background: "transparent", border: 0,
              color: active ? G.text : G.dim,
              padding: "4px 10px", borderRadius: 7,
              cursor: "pointer", fontFamily: "inherit",
              fontSize: 11, fontWeight: 600,
              letterSpacing: "0.04em",
              display: "inline-flex", alignItems: "center", gap: 5,
              transition: "color 160ms",
            }}
          >
            {opt.glyph && (
              <span style={{ color: active ? (opt.glyphColor ?? G.text) : G.muted, fontSize: 11 }}>
                {opt.glyph}
              </span>
            )}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function GlassChip({ active, color, onClick, children, title, small, disabled }: {
  active: boolean;
  color: string;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  small?: boolean;
  disabled?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const soft = active ? `${color}33` : "transparent";
  const borderC = active ? `${color}66` : G.border;
  const textC = disabled ? G.faint : (active ? color : (hover ? G.text : G.dim));
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover && !active && !disabled ? G.highlight : soft,
        border: `1px solid ${borderC}`,
        color: textC,
        padding: small ? "2px 8px" : "4px 10px",
        borderRadius: 999,
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "inherit",
        fontSize: small ? 10 : 11,
        fontWeight: active ? 600 : 500,
        letterSpacing: "0.03em",
        transition: "all 140ms",
        boxShadow: active ? `0 0 0 1px ${color}33, 0 0 12px -6px ${color}` : "none",
        whiteSpace: "nowrap",
        opacity: disabled ? 0.4 : 1,
        lineHeight: 1.4,
      }}
    >
      {children}
    </button>
  );
}

function GlassButton({ children, onClick, disabled, color, primary, small }: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  color: string;
  primary?: boolean;
  small?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: primary ? color : (hover ? G.highlight : G.inner),
        border: `1px solid ${primary ? color : G.border}`,
        color: primary ? "#0b1328" : (hover ? color : G.text),
        padding: small ? "3px 9px" : "5px 11px",
        borderRadius: 8,
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "inherit",
        fontSize: small ? 11 : 12,
        fontWeight: 600,
        letterSpacing: "0.03em",
        transition: "all 140ms",
        opacity: disabled ? 0.5 : 1,
        boxShadow: primary ? `0 0 0 1px ${color}33, 0 0 12px -4px ${color}` : "none",
        minWidth: primary ? 30 : undefined,
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
      }}
    >
      {children}
    </button>
  );
}

const glassInputStyle: React.CSSProperties = {
  background: G.inner,
  border: `1px solid ${G.border}`,
  borderRadius: 7,
  color: G.text,
  fontSize: 11,
  padding: "3px 8px",
  outline: "none",
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  colorScheme: "dark",
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 9,
  color: G.muted,
  letterSpacing: "0.14em",
  fontWeight: 600,
  textTransform: "uppercase",
};
