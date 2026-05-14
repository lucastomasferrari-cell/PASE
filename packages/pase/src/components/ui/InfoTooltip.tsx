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
  /** Tamaño del icono sol en px. Default: 14 (matchea íconos del sidebar). */
  size?: number;
}

export function InfoTooltip({ children, position = "right", maxWidth = 280, size = 14 }: InfoTooltipProps) {
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

// ─── SunIcon: Sol de Mayo simplificado ─────────────────────────────────────
// 8 rayos rectos + cara central. SVG estático, color dorado de marca.

function SunIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      {/* Rayos */}
      <g stroke="var(--pase-gold, #F5C518)" strokeWidth="1.1" strokeLinecap="round">
        <line x1="7" y1="0.8" x2="7" y2="2.6" />
        <line x1="7" y1="11.4" x2="7" y2="13.2" />
        <line x1="0.8" y1="7" x2="2.6" y2="7" />
        <line x1="11.4" y1="7" x2="13.2" y2="7" />
        <line x1="2.5" y1="2.5" x2="3.7" y2="3.7" />
        <line x1="10.3" y1="10.3" x2="11.5" y2="11.5" />
        <line x1="2.5" y1="11.5" x2="3.7" y2="10.3" />
        <line x1="10.3" y1="3.7" x2="11.5" y2="2.5" />
      </g>
      {/* Centro del sol */}
      <circle cx="7" cy="7" r="2.6" fill="var(--pase-gold, #F5C518)" />
    </svg>
  );
}
