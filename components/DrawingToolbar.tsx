/**
 * DrawingToolbar — Small professional toolbar for chart drawing tools.
 * Dark theme, clear icons. Does not interfere with trading.
 */
"use client";

import type { DrawingTool } from "../lib/drawings";

interface Props {
  tool: DrawingTool;
  onToolChange: (tool: DrawingTool) => void;
  onDeleteSelected: () => void;
  hasSelection: boolean;
}

const TOOLS: Array<{ id: DrawingTool; label: string; icon: string; title: string }> = [
  { id: "select", label: "Select", icon: "↖", title: "Select / move drawings (Esc)" },
  { id: "hline", label: "H-Line", icon: "—", title: "Horizontal price line — click chart to place" },
  { id: "trendline", label: "Trend", icon: "╱", title: "Trendline — click two points" },
];

export default function DrawingToolbar({ tool, onToolChange, onDeleteSelected, hasSelection }: Props) {
  return (
    <div
      style={{
        position: "absolute",
        left: 8,
        top: 8,
        zIndex: 20,
        display: "flex",
        gap: 4,
        background: "rgba(10,15,25,0.92)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 8,
        padding: 4,
      }}
    >
      {TOOLS.map((t) => (
        <button
          key={t.id}
          onClick={() => onToolChange(t.id)}
          title={t.title}
          style={{
            background: tool === t.id ? "#1e40af" : "transparent",
            color: tool === t.id ? "#fff" : "#94a3b8",
            border: "1px solid transparent",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 12,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span style={{ fontSize: 14 }}>{t.icon}</span>
          <span>{t.label}</span>
        </button>
      ))}
      <button
        onClick={onDeleteSelected}
        disabled={!hasSelection}
        title="Delete selected drawing (Del)"
        style={{
          background: "transparent",
          color: hasSelection ? "#f6465d" : "#475569",
          border: "1px solid transparent",
          borderRadius: 6,
          padding: "4px 8px",
          fontSize: 12,
          cursor: hasSelection ? "pointer" : "default",
        }}
      >
        🗑
      </button>
    </div>
  );
}
