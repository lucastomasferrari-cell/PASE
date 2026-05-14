import { useState, useRef, useEffect } from "react";

/**
 * InfoTooltip — botón sol dorado (☀️ Sol de Mayo simplificado) que al hover/focus
 * o click muestra un tooltip con info contextual.
 *
 * Patrón establecido 2026-05-14 (rediseño UX): toda info accesoria que antes
 * vivía como texto al lado del título de página (ej. "2 activos / 5 inactivos",
 * "Última actualización: hace 5 min") debe migrarse a un <InfoTooltip> al
 * costado del título. Mantiene el header limpio.
 *
 * Iconografía:
 *   - Sol de Mayo (símbolo nacional argentino, Bandera de Manuel Belgrano).
 *   - Versión simplificada: 8 rayos rectos + cara central.
 *   - Color: --pase-gold (#F5C518). El único otro lugar donde aparece el dorado
 *     en el producto es el punto del logo "pase.". Ahora se suma este sol como
 *     marca visual sutil de info contextual.
 *
 * Accesibilidad:
 *   - Botón con aria-label="Más información" (screen readers anuncian).
 *   - Trigger con mouse (hover) Y teclado (focus). Click también lo abre/cierra
 *     para mobile/touch.
 *   - Tooltip con role="tooltip".
 *   - Cierra al click afuera o al apretar Escape.
 */

interface InfoTooltipProps {
  /** Contenido del tooltip — texto plano o JSX rico. */
  children: React.ReactNode;
  /** Posición preferida del tooltip respecto del botón. Default: "right". */
  position?: "top" | "right" | "bottom" | "left";
  /** Ancho máximo del tooltip en px. Default: 280. */
  maxWidth?: number;
  /** Tamaño del icono sol en px. Default: 16 (necesita esta resolución mínima
   * para que se vean los detalles de la cara — ojos + boca). */
  size?: number;
}

export function InfoTooltip({ children, position = "right", maxWidth = 280, size = 16 }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  // Cerrar al click afuera (importante para el caso click-to-open en mobile).
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Posición del tooltip respecto del botón. Usamos coordenadas absolutas
  // dentro del wrapper (que tiene position: relative).
  const tooltipPositionStyle: React.CSSProperties = (() => {
    switch (position) {
      case "top":    return { bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)" };
      case "bottom": return { top: "calc(100% + 6px)",    left: "50%", transform: "translateX(-50%)" };
      case "left":   return { right: "calc(100% + 6px)",  top: "50%",  transform: "translateY(-50%)" };
      case "right":
      default:       return { left: "calc(100% + 6px)",   top: "50%",  transform: "translateY(-50%)" };
    }
  })();

  return (
    <span ref={wrapRef} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        type="button"
        aria-label="Más información"
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          width: size + 6,
          height: size + 6,
          padding: 0,
          background: "transparent",
          border: "none",
          cursor: "help",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          transition: "background 0.15s ease",
        }}
        onPointerEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--pase-celeste-100)"; }}
        onPointerLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
      >
        <SunIcon size={size} />
      </button>
      {open && (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            zIndex: 1000,
            background: "var(--pase-bg)",
            color: "var(--pase-text)",
            border: "0.5px solid var(--pase-celeste-300)",
            borderRadius: "var(--pase-radius-md, 8px)",
            padding: "8px 12px",
            fontSize: 11,
            lineHeight: 1.45,
            fontFamily: "var(--pase-font)",
            fontWeight: 400,
            letterSpacing: "-0.005em",
            maxWidth,
            width: "max-content",
            boxShadow: "0 4px 12px rgba(26, 58, 94, 0.08)",
            pointerEvents: "none",
            ...tooltipPositionStyle,
          }}
        >
          {children}
        </span>
      )}
    </span>
  );
}

// ─── SunIcon: Sol de Mayo CON CARA ─────────────────────────────────────────
// Versión más fiel al Sol de Mayo histórico (rediseñado 2026-05-14 contra
// referencias de Lucas): 16 rayos alternados (8 grandes rectos + 8 cortos
// inclinados a 22.5°), cara central con ojos + boca, todo en dorado de marca.
// A 14-16px renderizado los detalles se ven sutiles pero se perciben.

function SunIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {/* 8 rayos largos (norte, sur, este, oeste, NE, SE, SW, NW) */}
      <g stroke="var(--pase-gold, #F5C518)" strokeWidth="0.9" strokeLinecap="round">
        <line x1="8" y1="0.5" x2="8" y2="2.4" />
        <line x1="8" y1="13.6" x2="8" y2="15.5" />
        <line x1="0.5" y1="8" x2="2.4" y2="8" />
        <line x1="13.6" y1="8" x2="15.5" y2="8" />
        <line x1="2.6" y1="2.6" x2="4" y2="4" />
        <line x1="12" y1="12" x2="13.4" y2="13.4" />
        <line x1="2.6" y1="13.4" x2="4" y2="12" />
        <line x1="12" y1="4" x2="13.4" y2="2.6" />
      </g>
      {/* 8 rayos cortos (intercalados a 22.5°), más finos */}
      <g stroke="var(--pase-gold, #F5C518)" strokeWidth="0.65" strokeLinecap="round">
        <line x1="4.7" y1="1" x2="5.3" y2="2.3" />
        <line x1="11.3" y1="1" x2="10.7" y2="2.3" />
        <line x1="1" y1="4.7" x2="2.3" y2="5.3" />
        <line x1="1" y1="11.3" x2="2.3" y2="10.7" />
        <line x1="13.7" y1="5.3" x2="15" y2="4.7" />
        <line x1="13.7" y1="10.7" x2="15" y2="11.3" />
        <line x1="5.3" y1="13.7" x2="4.7" y2="15" />
        <line x1="10.7" y1="13.7" x2="11.3" y2="15" />
      </g>
      {/* Cara central (círculo dorado) */}
      <circle cx="8" cy="8" r="3.1" fill="var(--pase-gold, #F5C518)" />
      {/* Ojos (puntitos color texto, sutiles) */}
      <circle cx="6.85" cy="7.4" r="0.32" fill="var(--pase-text, #1A3A5E)" />
      <circle cx="9.15" cy="7.4" r="0.32" fill="var(--pase-text, #1A3A5E)" />
      {/* Boca (pequeña sonrisa) */}
      <path d="M 6.8 8.7 Q 8 9.4 9.2 8.7" stroke="var(--pase-text, #1A3A5E)" strokeWidth="0.32" strokeLinecap="round" fill="none" />
    </svg>
  );
}
