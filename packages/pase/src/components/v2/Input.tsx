// PASE V2 — Input
// Field con label arriba, sin floating-label (cleaner). Soporta:
// - type=text|number|date|email|password
// - prefix/suffix (ej "$", "%")
// - error state (rojo único)
// - hint opcional debajo

import type { CSSProperties, InputHTMLAttributes, ReactNode } from "react";

// NOTA: omito "prefix" del HTML attr porque entra en conflicto con el
// `prefix` que queremos exponer como ReactNode (el atributo HTML es string).
interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  label?: string;
  hint?: string;
  error?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
  fullWidth?: boolean;
  containerStyle?: CSSProperties;
}

export function Input({
  label, hint, error, prefix, suffix, fullWidth, containerStyle,
  style, ...rest
}: InputProps) {
  const wrapperStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--v2-space-1)",
    width: fullWidth ? "100%" : "auto",
    ...containerStyle,
  };

  const fieldWrapStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    background: "var(--v2-bg-3)",
    border: `1px solid ${error ? "var(--v2-rojo)" : "var(--v2-border)"}`,
    borderRadius: "var(--v2-radius-sm)",
    padding: "0 var(--v2-space-3)",
    transition: "border-color var(--v2-tr-fast)",
  };

  const inputStyle: CSSProperties = {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    padding: "8px 0",
    color: "var(--v2-text)",
    fontFamily: rest.type === "number" ? "var(--v2-font-mono)" : "var(--v2-font-body)",
    fontSize: "var(--v2-fs-sm)",
    fontVariantNumeric: rest.type === "number" ? "tabular-nums" : undefined,
    minWidth: 0,
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
      <div style={fieldWrapStyle}>
        {prefix && (
          <span style={{
            color: "var(--v2-text-subtle)",
            fontSize: "var(--v2-fs-sm)",
            marginRight: "var(--v2-space-2)",
            display: "inline-flex",
          }}>{prefix}</span>
        )}
        <input {...rest} style={inputStyle} />
        {suffix && (
          <span style={{
            color: "var(--v2-text-subtle)",
            fontSize: "var(--v2-fs-sm)",
            marginLeft: "var(--v2-space-2)",
            display: "inline-flex",
          }}>{suffix}</span>
        )}
      </div>
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
