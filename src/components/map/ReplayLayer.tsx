"use client";

import { useEffect, useRef } from "react";
import { useMap } from "./MapContext";

const SOURCE = "replay";
const LAYER_DOT = "replay-dots";
const LAYER_LABEL = "replay-labels";

export interface VesselPoint {
  t: number;   // epoch seconds
  lat: number;
  lon: number;
  sog: number | null;
  cog: number | null;
}

export type TrackMap = Map<number, { name: string | null; points: VesselPoint[] }>;

interface HoverData {
  x: number; y: number;
  mmsi: number; name: string | null;
  sog: number | null; cog: number | null; heading: number | null;
  lat: number; lon: number; updated_at: string | null;
}

interface Props {
  tracks: TrackMap;
  currentTime: number; // epoch ms
  onVesselClick: (v: { mmsi: number; name: string | null; lat: number; lon: number; sog: number | null; cog: number | null; heading: null; updated_at: string | null }) => void;
  onHover: (d: HoverData | null) => void;
  hiddenMmsi?: number | null;
  dimOthers?: boolean;
}

function interpolate(points: VesselPoint[], tMs: number): VesselPoint | null {
  const t = tMs / 1000;
  if (!points.length) return null;
  if (t < points[0].t - 600) return null;   // vessel not arrived yet (10 min grace)
  if (t > points[points.length - 1].t + 600) return null; // vessel gone (10 min grace)

  // Binary search for surrounding points
  let lo = 0, hi = points.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  if (!b || b.t === a.t) return a;
  const frac = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  return {
    t,
    lat: a.lat + frac * (b.lat - a.lat),
    lon: a.lon + frac * (b.lon - a.lon),
    sog: a.sog,
    cog: a.cog,
  };
}

export default function ReplayLayer({ tracks, currentTime, onVesselClick, onHover, hiddenMmsi, dimOthers }: Props) {
  const map = useMap();
  const initializedRef = useRef(false);

  // Initialize layers once
  useEffect(() => {
    if (!map || initializedRef.current) return;
    initializedRef.current = true;

    map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });

    map.addLayer({
      id: LAYER_DOT,
      type: "circle",
      source: SOURCE,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 4, 10, 7, 14, 10],
        "circle-color": "#f59e0b",
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#ffffff",
        "circle-opacity": 0.95,
      },
    });

    map.addLayer({
      id: LAYER_LABEL,
      type: "symbol",
      source: SOURCE,
      layout: {
        "text-field": ["get", "name"],
        "text-size": 11,
        "text-offset": [0, 1.4],
        "text-anchor": "top",
      },
      paint: {
        "text-color": "#f5d57a",
        "text-halo-color": "#020a12",
        "text-halo-width": 1.5,
      },
    });

    const handleClick = (e: maplibregl.MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: [LAYER_DOT] });
      if (!features.length) return;
      const p = features[0].properties as any;
      const coords = (features[0].geometry as GeoJSON.Point).coordinates;
      onVesselClick({
        mmsi: p.mmsi, name: p.name || null,
        lat: coords[1], lon: coords[0],
        sog: p.sog ?? null, cog: p.cog ?? null,
        heading: null, updated_at: null,
      });
    };
    map.on("click", LAYER_DOT, handleClick);

    const handleMouseMove = (e: maplibregl.MapMouseEvent) => {
      const features = map.queryRenderedFeatures(e.point, { layers: [LAYER_DOT] });
      if (!features.length) { onHover(null); map.getCanvas().style.cursor = ""; return; }
      map.getCanvas().style.cursor = "pointer";
      const p = features[0].properties as any;
      const coords = (features[0].geometry as GeoJSON.Point).coordinates;
      onHover({ x: e.originalEvent.clientX, y: e.originalEvent.clientY, mmsi: p.mmsi, name: p.name || null, sog: p.sog ?? null, cog: p.cog ?? null, heading: null, lat: coords[1], lon: coords[0], updated_at: null });
    };
    const handleMouseLeave = () => { onHover(null); map.getCanvas().style.cursor = ""; };
    map.on("mousemove", LAYER_DOT, handleMouseMove);
    map.on("mouseleave", LAYER_DOT, handleMouseLeave);

    return () => {
      map.off("click", LAYER_DOT, handleClick);
      map.off("mousemove", LAYER_DOT, handleMouseMove);
      map.off("mouseleave", LAYER_DOT, handleMouseLeave);
      if (map.getLayer(LAYER_LABEL)) map.removeLayer(LAYER_LABEL);
      if (map.getLayer(LAYER_DOT)) map.removeLayer(LAYER_DOT);
      if (map.getSource(SOURCE)) map.removeSource(SOURCE);
      initializedRef.current = false;
    };
  }, [map]);

  // Dim all dots when another vessel is focused
  useEffect(() => {
    if (!map || !map.getLayer(LAYER_DOT)) return;
    map.setPaintProperty(LAYER_DOT, "circle-opacity", dimOthers ? 0.18 : 0.95);
    map.setPaintProperty(LAYER_DOT, "circle-stroke-opacity", dimOthers ? 0.18 : 1);
    map.setPaintProperty(LAYER_LABEL, "text-opacity", dimOthers ? 0 : 1);
  }, [map, dimOthers]);

  // Hide selected vessel dot
  useEffect(() => {
    if (!map || !map.getLayer(LAYER_DOT)) return;
    if (hiddenMmsi != null) {
      map.setFilter(LAYER_DOT, ["!=", ["get", "mmsi"], hiddenMmsi]);
      map.setFilter(LAYER_LABEL, ["!=", ["get", "mmsi"], hiddenMmsi]);
    } else {
      map.setFilter(LAYER_DOT, null);
      map.setFilter(LAYER_LABEL, null);
    }
  }, [map, hiddenMmsi]);

  // Update positions whenever currentTime or tracks changes
  useEffect(() => {
    if (!map || !map.getSource(SOURCE)) return;
    const features: GeoJSON.Feature[] = [];
    tracks.forEach((vessel, mmsi) => {
      const pos = interpolate(vessel.points, currentTime);
      if (!pos) return;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [pos.lon, pos.lat] },
        properties: { mmsi, name: vessel.name, sog: pos.sog, cog: pos.cog },
      });
    });
    (map.getSource(SOURCE) as maplibregl.GeoJSONSource)?.setData({ type: "FeatureCollection", features });
  }, [map, tracks, currentTime]);

  return null;
}
