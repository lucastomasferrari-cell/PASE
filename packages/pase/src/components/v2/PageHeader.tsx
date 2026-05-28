// PASE V2 — PageHeader
// Header consistente para cada pantalla:
// - eyebrow (breadcrumb tipo "Operación / Caja")
// - h1 (título grande)
// - sub (descripción 1 línea)
// - actions a la derecha (botones)

import type { ReactNode } from "react";

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  sub?: string;
  actions?: ReactNode;
}

export function PageHeader({ eyebrow, title, sub, actions }: PageHeaderProps) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      marginBottom: "var(--v2-space-6)",
      paddingBottom: "var(--v2-space-4)",
      borderBottom: "1px solid var(--v2-border)",
      gap: "var(--v2-space-4)",
      flexWrap: "wrap",
    }}>
      <div style={{ flex: 1, minWidth: 280 }}>
        {eyebrow && (
          <div className="v2-eyebrow" style={{ marginBottom: "var(--v2-space-1)" }}>
            {eyebrow}
          </div>
        )}
        <h1 className="v2-h1" style={{ fontSize: "var(--v2-fs-2xl)" }}>
          {title}
        </h1>
        {sub && (
          <div style={{
            color: "var(--v2-text-muted)",
            fontSize: "var(--v2-fs-sm)",
            marginTop: "var(--v2-space-1)",
          }}>
            {sub}
          </div>
        )}
      </div>
      {actions && (
        <div style={{
          display: "flex",
          gap: "var(--v2-space-2)",
          flexWrap: "wrap",
        }}>
          {actions}
        </div>
      )}
    </div>
  );
}
