"use client";

import { useState } from "react";

export default function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      onClick={handleCopy}
      style={{
        fontSize: "11px",
        fontFamily: "var(--font-mono)",
        fontWeight: 600,
        color: copied ? "#00e676" : "rgba(255,255,255,0.35)",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: "0",
        transition: "color 0.15s",
        whiteSpace: "nowrap",
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
