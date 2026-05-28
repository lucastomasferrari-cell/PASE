// PASE V2 — Badge
// Variantes:
//   - info:      celeste (default) — neutro informativo
//   - atencion:  dorado — alerta suave / pendiente
//   - error:     rojo único — solo errores bloqueantes reales
//   - neutro:    gris — estados muertos / inactivos
//
// SIN VERDES (para "ok" usar texto blanco + tick aparte, no badge).

import type { CSSProperties, ReactNode } from "react";

interface BadgeProps {
  children: ReactNode;
  variant?: "info" | "atencion" | "error" | "neutro";
  dot?: boolean;
  className?: string;
}

const variantStyles: Record<string, CSSProperties> = {
  info: {
    background: "var(--v2-celeste-dim)",
    color: "var(--v2-celeste)",
    border: "1px solid rgba(110, 181, 255, 0.25)",
  },
  atencion: {
    background: "var(--v2-dorado-dim)",
    color: "var(--v2-dorado)",
    border: "1px solid rgba(212, 175, 55, 0.30)",
  },
  error: {
    background: "var(--v2-rojo-dim)",
    color: "var(--v2-rojo)",
    border: "1px solid rgba(184, 84, 80, 0.30)",
  },
  neutro: {
    background: "var(--v2-bg-3)",
    color: "var(--v2-text-muted)",
    border: "1px solid var(--v2-border)",
  },
};

export function Badge({ children, variant = "info", dot = false, className = "" }: BadgeProps) {
  const dotColor = variant === "atencion" ? "var(--v2-dorado)"
                  : variant === "error" ? "var(--v2-rojo)"
                  : variant === "neutro" ? "var(--v2-text-muted)"
                  : "var(--v2-celeste)";

  return (
    <span
      className={`v2-badge ${className}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "3px 10px",
        borderRadius: "var(--v2-radius-pill)",
        fontSize: "var(--v2-fs-xs)",
        fontWeight: "var(--v2-fw-semibold)",
        lineHeight: 1.4,
        ...variantStyles[variant],
      }}
    >
      {dot && (
        <span style={{
          width: 6, height: 6, borderRadius: "50%", background: dotColor,
          display: "inline-block", flexShrink: 0,
        }} />
      )}
      {children}
    </span>
  );
}
