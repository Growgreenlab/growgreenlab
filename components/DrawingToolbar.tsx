/**
 * DrawingToolbar — Professional compact drawing toolbar.
 * Grouped tools, active highlighting, undo/redo, touch-friendly.
 */
"use client";

import { useState } from "react";
import type { DrawingTool } from "../lib/drawings";

interface Props {
  tool: DrawingTool;
  onToolChange: (tool: DrawingTool) => void;
  onDeleteSelected: () => void;
  hasSelection: boolean;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

interface ToolDef {
  id: DrawingTool;
  label: string;
  icon: string;
  title: string;
  group: "cursor" | "lines" | "shapes" | "annotations";
}

const TOOLS: ToolDef[] = [
  { id: "select", label: "Select", icon: "↖", title: "Select / move drawings (V)", group: "cursor" },
  { id: "trendline", label: "Trend Line", icon: "╱", title: "Trend line — click two points (T)", group: "lines" },
  { id: "hline", label: "H-Line", icon: "—", title: "Horizontal line — click at price (H)", group: "lines" },
  { id: "hray", label: "H-Ray", icon: "—→", title: "Horizontal ray — extends right", group: "lines" },
  { id: "vline", label: "V-Line", icon: "│", title: "Vertical line — click at time", group: "lines" },
  { id: "extended", label: "Ext Line", icon: "⟷", title: "Extended line — infinite both directions", group: "lines" },
  { id: "rect", label: "Rectangle", icon: "▭", title: "Rectangle — click two corners (R)", group: "shapes" },
  { id: "text", label: "Text", icon: "T", title: "Text annotation — click to place", group: "annotations" },
  { id: "arrow", label: "Arrow", icon: "→", title: "Arrow — click two points", group: "annotations" },
];

const GROUP_LABELS: Record<string, string> = {
  cursor: "Cursor",
  lines: "Lines",
  shapes: "Shapes",
  annotations: "Annotations",
};

export default function DrawingToolbar({
  tool, onToolChange, onDeleteSelected, hasSelection,
  onUndo, onRedo, canUndo, canRedo,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  const activeTool = TOOLS.find((t) => t.id === tool);
  const groups = ["cursor", "lines", "shapes", "annotations"] as const;

  const btnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? "rgba(16,185,129,0.18)" : "transparent",
    color: active ? "#34d399" : "#8fa3ad",
    border: active ? "1px solid rgba(16,185,129,0.4)" : "1px solid transparent",
    borderRadius: 6,
    padding: "6px 8px",
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 6,
    whiteSpace: "nowrap",
    minHeight: 32,
  });

  return (
    <div
      // CRITICAL: Stop all pointer events from bubbling to the chart.
      // Toolbar clicks must NEVER create drawings or interfere with chart interactions.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: 8,
        top: 8,
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        background: "rgba(10,15,25,0.94)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 10,
        padding: 6,
        maxWidth: 220,
      }}
    >
      {/* Compact bar: active tool + expand + undo/redo + delete */}
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <button
          onClick={() => setExpanded(!expanded)}
          title="Drawing tools"
          style={{
            ...btnStyle(false),
            flex: 1,
            justifyContent: "flex-start",
          }}
        >
          <span style={{ fontSize: 14 }}>{activeTool?.icon ?? "↖"}</span>
          <span>{activeTool?.label ?? "Select"}</span>
          <span style={{ marginLeft: "auto", fontSize: 10, opacity: 0.6 }}>
            {expanded ? "▲" : "▼"}
          </span>
        </button>
        <button onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)"
          style={{ ...btnStyle(false), opacity: canUndo ? 1 : 0.35, padding: "6px" }}>
          ↩
        </button>
        <button onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)"
          style={{ ...btnStyle(false), opacity: canRedo ? 1 : 0.35, padding: "6px" }}>
          ↪
        </button>
        <button onClick={onDeleteSelected} disabled={!hasSelection}
          title="Delete selected (Del)"
          style={{
            ...btnStyle(false),
            color: hasSelection ? "#f87171" : "#475569",
            opacity: hasSelection ? 1 : 0.4,
            padding: "6px",
          }}>
          🗑
        </button>
      </div>

      {/* Expanded tool groups */}
      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 300, overflowY: "auto" }}>
          {groups.map((g) => (
            <div key={g}>
              <div style={{
                fontSize: 10, fontWeight: 600, letterSpacing: 0.8,
                textTransform: "uppercase", color: "#5f727c",
                marginBottom: 4, paddingLeft: 4,
              }}>
                {GROUP_LABELS[g]}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {TOOLS.filter((t) => t.group === g).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => { onToolChange(t.id); setExpanded(false); }}
                    title={t.title}
                    style={btnStyle(tool === t.id)}
                  >
                    <span style={{ fontSize: 14 }}>{t.icon}</span>
                    <span style={{ fontSize: 11 }}>{t.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
