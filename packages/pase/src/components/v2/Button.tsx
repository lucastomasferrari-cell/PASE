// PASE V2 — Button
// Variantes:
//   - primary:  celeste (default) — acciones secundarias y generales
//   - premium:  dorado — acciones premium (Pagar, Confirmar transacción)
//   - outline:  borde celeste, fondo transparente — secundario
//   - ghost:    sin borde, hover sutil — terciario
//   - danger:   rojo único — solo destructive REAL
//
// Sin emojis. Iconos van como prop `icon` (Lucide).

import type { CSSProperties, ReactNode } from "react";

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "premium" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: ReactNode;
  iconRight?: ReactNode;
  disabled?: boolean;
  fullWidth?: boolean;
  className?: string;
  style?: CSSProperties;
}

const variantStyles: Record<string, CSSProperties> = {
  primary: {
    background: "var(--v2-celeste)",
    color: "#0A0E14",
    border: "1px solid var(--v2-celeste)",
  },
  premium: {
    background: "var(--v2-dorado)",
    color: "#0A0E14",
    border: "1px solid var(--v2-dorado)",
  },
  outline: {
    background: "transparent",
    color: "var(--v2-celeste)",
    border: "1px solid var(--v2-celeste)",
  },
  ghost: {
    background: "transparent",
    color: "var(--v2-text)",
    border: "1px solid transparent",
  },
  danger: {
    background: "var(--v2-rojo)",
    color: "#FFFFFF",
    border: "1px solid var(--v2-rojo)",
  },
};

const sizeStyles: Record<string, CSSProperties> = {
  sm: { padding: "6px 12px", fontSize: "var(--v2-fs-xs)", borderRadius: "var(--v2-radius-sm)", gap: "var(--v2-space-1)" },
  md: { padding: "9px 16px", fontSize: "var(--v2-fs-sm)", borderRadius: "var(--v2-radius-sm)", gap: "var(--v2-space-2)" },
  lg: { padding: "12px 24px", fontSize: "var(--v2-fs-base)", borderRadius: "var(--v2-radius-md)", gap: "var(--v2-space-2)" },
};

export function Button({
  children, onClick, type = "button", variant = "primary", size = "md",
  icon, iconRight, disabled, fullWidth, className = "", style,
}: ButtonProps) {
  const baseStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--v2-font-body)",
    fontWeight: "var(--v2-fw-semibold)",
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "all var(--v2-tr-fast)",
    opacity: disabled ? 0.5 : 1,
    width: fullWidth ? "100%" : "auto",
    whiteSpace: "nowrap",
    ...variantStyles[variant],
    ...sizeStyles[size],
    ...style,
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`v2-button ${className}`}
      style={baseStyle}
    >
      {icon && <span style={{ display: "inline-flex" }}>{icon}</span>}
      {children}
      {iconRight && <span style={{ display: "inline-flex" }}>{iconRight}</span>}
    </button>
  );
}
