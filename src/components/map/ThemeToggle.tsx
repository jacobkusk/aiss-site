"use client";

interface Props {
  theme: "dark" | "light";
  onChange: (t: "dark" | "light") => void;
}

export default function ThemeToggle({ theme, onChange }: Props) {
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 35,
        display: "flex",
        background: theme === "dark" ? "rgba(4, 12, 20, 0.92)" : "rgba(255, 255, 255, 0.92)",
        border: `1px solid ${theme === "dark" ? "rgba(43, 168, 200, 0.2)" : "rgba(0,0,0,0.12)"}`,
        borderRadius: 8,
        overflow: "hidden",
        backdropFilter: "blur(8px)",
      }}
    >
      <button
        onClick={() => onChange("dark")}
        title="Mørk baggrund"
        style={{
          padding: "8px 14px",
          background: theme === "dark" ? "rgba(43, 168, 200, 0.15)" : "transparent",
          border: "none",
          borderRight: `1px solid ${theme === "dark" ? "rgba(43, 168, 200, 0.2)" : "rgba(0,0,0,0.12)"}`,
          color: theme === "dark" ? "#2ba8c8" : "#888",
          fontSize: 12,
          fontWeight: theme === "dark" ? 600 : 500,
          cursor: "pointer",
          fontFamily: "var(--font-mono, monospace)",
          letterSpacing: "0.05em",
        }}
      >
        🌙 DARK
      </button>
      <button
        onClick={() => onChange("light")}
        title="Lys baggrund"
        style={{
          padding: "8px 14px",
          background: theme === "light" ? "rgba(0,0,0,0.08)" : "transparent",
          border: "none",
          color: theme === "light" ? "#111" : "#5a8090",
          fontSize: 12,
          fontWeight: theme === "light" ? 600 : 500,
          cursor: "pointer",
          fontFamily: "var(--font-mono, monospace)",
          letterSpacing: "0.05em",
        }}
      >
        ☀ LIGHT
      </button>
    </div>
  );
}
