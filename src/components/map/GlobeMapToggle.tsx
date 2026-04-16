"use client";

import { useState } from "react";
import { useMap } from "./MapContext";

interface Props {
  isOverlay?: boolean;
}

export default function GlobeMapToggle({ isOverlay = false }: Props) {
  const map = useMap();
  const [isGlobe, setIsGlobe] = useState(false);

  const handleGlobe = () => {
    if (!map) return;
    if (isGlobe) return; // Already globe
    // MapLibre supports dynamic projection switching
    (map as any).setProjection({ type: "globe" });
    // Globe looks best zoomed out
    if (map.getZoom() > 5) map.easeTo({ zoom: 2.5, duration: 600 });
    setIsGlobe(true);
  };

  const handleMap = () => {
    if (!map) return;
    if (!isGlobe) return; // Already map
    // Switch to mercator projection
    (map as any).setProjection({ type: "mercator" });
    setIsGlobe(false);
  };

  // Overlay segment control (top center)
  if (isOverlay) {
    return (
      <div
        style={{
          position: "absolute",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 35,
          display: "flex",
          background: "rgba(4, 12, 20, 0.92)",
          border: "1px solid rgba(43, 168, 200, 0.2)",
          borderRadius: 8,
          overflow: "hidden",
          backdropFilter: "blur(8px)",
        }}
      >
        <button
          onClick={handleGlobe}
          title="Vis som globus"
          style={{
            flex: 1,
            padding: "8px 16px",
            background: isGlobe ? "rgba(43, 168, 200, 0.15)" : "transparent",
            border: "none",
            borderRight: "1px solid rgba(43, 168, 200, 0.2)",
            color: isGlobe ? "#2ba8c8" : "#5a8090",
            fontSize: 12,
            fontWeight: isGlobe ? 600 : 500,
            cursor: "pointer",
            fontFamily: "var(--font-mono, monospace)",
            letterSpacing: "0.05em",
            transition: "all 0.15s",
            whiteSpace: "nowrap",
          }}
        >
          🌍 GLOBE
        </button>
        <button
          onClick={handleMap}
          title="Vis som kort"
          style={{
            flex: 1,
            padding: "8px 16px",
            background: !isGlobe ? "rgba(43, 168, 200, 0.15)" : "transparent",
            border: "none",
            color: !isGlobe ? "#2ba8c8" : "#5a8090",
            fontSize: 12,
            fontWeight: !isGlobe ? 600 : 500,
            cursor: "pointer",
            fontFamily: "var(--font-mono, monospace)",
            letterSpacing: "0.05em",
            transition: "all 0.15s",
            whiteSpace: "nowrap",
          }}
        >
          🗺 MAP
        </button>
      </div>
    );
  }

  // Fallback single button (bottom right)
  const toggle = () => {
    if (!map) return;
    const next = !isGlobe;
    (map as any).setProjection(next ? { type: "globe" } : { type: "mercator" });
    if (next) {
      if (map.getZoom() > 5) map.easeTo({ zoom: 2.5, duration: 600 });
    }
    setIsGlobe(next);
  };

  return (
    <button
      onClick={toggle}
      title={isGlobe ? "Skift til flat kort" : "Skift til globus"}
      style={{
        position: "absolute",
        bottom: 70,
        right: 12,
        zIndex: 10,
        background: "rgba(4, 12, 20, 0.92)",
        border: `1px solid ${isGlobe ? "rgba(43,168,200,0.6)" : "rgba(43,168,200,0.25)"}`,
        borderRadius: 6,
        color: isGlobe ? "#2ba8c8" : "#5a8090",
        fontSize: 18,
        width: 36,
        height: 36,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(6px)",
        transition: "border-color 0.2s, color 0.2s",
      }}
    >
      {isGlobe ? "🗺" : "🌍"}
    </button>
  );
}
