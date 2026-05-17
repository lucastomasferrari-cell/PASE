import type { ReactNode } from "react";
import { Card } from "./Card";

/**
 * StatCard — KPI card del sistema de diseño PASE.
 *
 * Estructura visual:
 *   - Label arriba (sm, muted)
 *   - Valor principal grande (2xl bold, tabular-nums)
 *   - Sub-texto opcional abajo (xs, muted)
 *   - Trend opcional (ej. "+8.2%" en verde/rojo)
 *
 * Variantes:
 *   - default: card blanca
 *   - anchor:  celeste sólido + texto blanco (Caja Efectivo, Facturación mes)
 *
 * Uso:
 * ```tsx
 * <StatCard
 *   label="Ventas hoy"
 *   value="$ 12.450,00"
 *   sub="42 tickets"
 *   trend={{ value: "+8.2%", direction: "up" }}
 * />
 * ```
 */

interface Props {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  trend?: {
    value: string;
    /** up = celeste, down = rojo suave, neutral = muted */
    direction: "up" | "down" | "neutral";
  };
  variant?: "default" | "anchor";
  /** Si tiene onClick, se vuelve clickable */
  onClick?: () => void;
  /** Ícono SVG inline opcional (~14x14) a la izquierda del label */
  icon?: ReactNode;
}

const TREND_COLORS = {
  up:      { color: "var(--pase-celeste)" },
  down:    { color: "#B91C1C" },
  neutral: { color: "var(--pase-text-muted)" },
};

const TREND_ARROWS = {
  up: "↑",
  down: "↓",
  neutral: "·",
};

export function StatCard({ label, value, sub, trend, variant = "default", onClick, icon }: Props) {
  return (
    <Card
      variant={variant}
      padding="lg"
      onClick={onClick}
      label={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {icon && <span style={{ width: 14, height: 14, flexShrink: 0, display: "inline-flex" }}>{icon}</span>}
          {label}
        </span>
      }
    >
      <div style={{
        fontSize: "var(--pase-fs-2xl)",
        fontWeight: 500,
        letterSpacing: "var(--pase-ls-tight)",
        fontVariantNumeric: "tabular-nums",
        lineHeight: 1.1,
        marginTop: 4,
        color: variant === "anchor" ? "#fff" : "var(--pase-text)",
        position: "relative",
        zIndex: 1,
      }}>
        {value}
      </div>
      {(sub || trend) && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 8,
          fontSize: "var(--pase-fs-xs)",
          color: variant === "anchor" ? "rgba(255,255,255,0.78)" : "var(--pase-text-muted)",
          position: "relative",
          zIndex: 1,
        }}>
          {trend && (
            <span style={{
              ...TREND_COLORS[trend.direction],
              fontWeight: 500,
              fontVariantNumeric: "tabular-nums",
              color: variant === "anchor" && trend.direction === "up" ? "#FFE08A" : TREND_COLORS[trend.direction].color,
            }}>
              {TREND_ARROWS[trend.direction]} {trend.value}
            </span>
          )}
          {sub && <span>{sub}</span>}
        </div>
      )}
    </Card>
  );
}
