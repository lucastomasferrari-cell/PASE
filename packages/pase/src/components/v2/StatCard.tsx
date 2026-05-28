// PASE V2 — Componente StatCard
// Uso: mostrar KPI con label + valor + opcional sub texto y status.
// Variantes:
//   - default: card neutra para KPI secundario
//   - hero:    KPI grande con dorado (el más importante)
//
// REGLAS:
// - Sin emojis. Sin colores random. Solo paleta v2.
// - Variante "hero" reserva el dorado para KPIs ANCLA (Prime Cost, Nómina mes, AvT).

import type { CSSProperties, ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  hero?: boolean;          // KPI principal — protagoniza con dorado
  status?: "ok" | "atencion" | "error";   // estado opcional debajo del sub
  statusText?: string;
  icon?: ReactNode;        // ícono Lucide opcional (no emoji)
  trend?: "up" | "down" | null;
  trendValue?: string;
  className?: string;
  style?: CSSProperties;
}

export function StatCard({
  label, value, sub, hero = false, status, statusText, icon, trend, trendValue, className = "", style,
}: StatCardProps) {
  const baseStyle: CSSProperties = {
    background: "var(--v2-bg-2)",
    border: hero ? "1px solid rgba(212,175,55,0.3)" : "1px solid var(--v2-border)",
    borderRadius: "var(--v2-radius-md)",
    padding: "var(--v2-space-4)",
    transition: "border-color var(--v2-tr-base)",
    ...style,
  };

  const labelStyle: CSSProperties = {
    fontSize: "var(--v2-fs-xs)",
    fontWeight: "var(--v2-fw-semibold)",
    letterSpacing: "var(--v2-tracking-wider)",
    textTransform: "uppercase",
    color: "var(--v2-text-muted)",
    marginBottom: "var(--v2-space-2)",
    display: "flex",
    alignItems: "center",
    gap: "var(--v2-space-2)",
  };

  const valueStyle: CSSProperties = {
    fontSize: hero ? "var(--v2-fs-3xl)" : "var(--v2-fs-2xl)",
    fontWeight: hero ? "var(--v2-fw-black)" : "var(--v2-fw-bold)",
    letterSpacing: "var(--v2-tracking-tight)",
    color: hero ? "var(--v2-dorado)" : "var(--v2-text-strong)",
    lineHeight: "var(--v2-lh-tight)",
    fontFamily: "var(--v2-font-mono)",
    fontVariantNumeric: "tabular-nums",
  };

  const subStyle: CSSProperties = {
    fontSize: "var(--v2-fs-xs)",
    color: "var(--v2-text-subtle)",
    marginTop: "var(--v2-space-1)",
  };

  const statusStyles: Record<string, CSSProperties> = {
    ok: { color: "var(--v2-text-muted)" },
    atencion: { color: "var(--v2-dorado)" },
    error: { color: "var(--v2-rojo)" },
  };

  return (
    <div className={`v2-stat-card ${className}`} style={baseStyle}>
      <div style={labelStyle}>
        {icon && <span style={{ display: "inline-flex", color: "var(--v2-text-subtle)" }}>{icon}</span>}
        {label}
      </div>
      <div style={valueStyle}>{value}</div>
      {sub && <div style={subStyle}>{sub}</div>}
      {status && statusText && (
        <div style={{
          marginTop: "var(--v2-space-2)",
          fontSize: "var(--v2-fs-xs)",
          fontWeight: "var(--v2-fw-semibold)",
          display: "flex",
          alignItems: "center",
          gap: "var(--v2-space-2)",
          ...statusStyles[status],
        }}>
          {status === "ok" && <span style={{ color: "var(--v2-celeste)" }}>✓</span>}
          {status === "atencion" && (
            <span style={{
              width: 6, height: 6, borderRadius: "50%", background: "var(--v2-dorado)",
            }} />
          )}
          {status === "error" && <span>✗</span>}
          {statusText}
        </div>
      )}
      {trend && trendValue && (
        <div style={{
          marginTop: "var(--v2-space-1)",
          fontSize: "var(--v2-fs-xs)",
          color: trend === "up" ? "var(--v2-dorado)" : "var(--v2-text-muted)",
          fontWeight: "var(--v2-fw-medium)",
        }}>
          {trend === "up" ? "↑" : "↓"} {trendValue}
        </div>
      )}
    </div>
  );
}
