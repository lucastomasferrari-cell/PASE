// PASE V2 — Select
// Wrapper alrededor de <select> nativo con estilo v2.
// Para selects custom complejos (con search), crear SelectCombo aparte.

import type { CSSProperties, SelectHTMLAttributes, ReactNode } from "react";

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  label?: string;
  hint?: string;
  error?: string;
  fullWidth?: boolean;
  children: ReactNode;
  containerStyle?: CSSProperties;
}

export function Select({
  label, hint, error, fullWidth, children, containerStyle, style, ...rest
}: SelectProps) {
  const wrapperStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--v2-space-1)",
    width: fullWidth ? "100%" : "auto",
    ...containerStyle,
  };

  const selectStyle: CSSProperties = {
    background: "var(--v2-bg-3)",
    border: `1px solid ${error ? "var(--v2-rojo)" : "var(--v2-border)"}`,
    borderRadius: "var(--v2-radius-sm)",
    padding: "8px var(--v2-space-3)",
    color: "var(--v2-text)",
    fontFamily: "var(--v2-font-body)",
    fontSize: "var(--v2-fs-sm)",
    outline: "none",
    cursor: "pointer",
    appearance: "none",
    backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%2394A3B8' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>\")",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 12px center",
    paddingRight: "32px",
    ...style,
  };

  return (
    <div style={wrapperStyle}>
      {label && (
        <label style={{
          fontSize: "var(--v2-fs-xs)",
          fontWeight: "var(--v2-fw-semibold)",
          color: "var(--v2-text-muted)",
          letterSpacing: "var(--v2-tracking-wider)",
          textTransform: "uppercase",
        }}>
          {label}
        </label>
      )}
      <select {...rest} style={selectStyle}>
        {children}
      </select>
      {(error || hint) && (
        <div style={{
          fontSize: "var(--v2-fs-xs)",
          color: error ? "var(--v2-rojo)" : "var(--v2-text-subtle)",
        }}>
          {error || hint}
        </div>
      )}
    </div>
  );
}
