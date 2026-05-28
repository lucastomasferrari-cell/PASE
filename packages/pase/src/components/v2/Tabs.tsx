// PASE V2 — Tabs
// Tabs horizontales con border-bottom celeste para el activo.
// Sin animaciones, sin pill, minimalismo Toast/R365.

import type { ReactNode } from "react";

interface Tab {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  activeId: string;
  onChange: (id: string) => void;
}

export function Tabs({ tabs, activeId, onChange }: TabsProps) {
  return (
    <div style={{
      display: "flex",
      borderBottom: "1px solid var(--v2-border)",
      gap: 0,
    }}>
      {tabs.map(tab => {
        const isActive = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            style={{
              background: "transparent",
              border: "none",
              padding: "var(--v2-space-3) var(--v2-space-4)",
              cursor: "pointer",
              color: isActive ? "var(--v2-celeste)" : "var(--v2-text-muted)",
              fontFamily: "var(--v2-font-body)",
              fontSize: "var(--v2-fs-sm)",
              fontWeight: isActive ? "var(--v2-fw-semibold)" : "var(--v2-fw-medium)",
              borderBottom: `2px solid ${isActive ? "var(--v2-celeste)" : "transparent"}`,
              marginBottom: "-1px",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--v2-space-2)",
              transition: "color var(--v2-tr-fast), border-color var(--v2-tr-fast)",
            }}
          >
            {tab.icon}
            {tab.label}
            {tab.badge}
          </button>
        );
      })}
    </div>
  );
}
