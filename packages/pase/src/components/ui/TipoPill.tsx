/**
 * TipoPill — pill (chip) con color consistente por tipo de gasto / movimiento.
 *
 * Pedido de Lucas (2026-05-14): en la pantalla Ajustes los tipos se ven con
 * colores diferenciados (Fijo celeste, Variable beige, Publicidad lila, etc.)
 * pero en Gastos están TODAS grises iguales. Inconsistencia visual feo.
 *
 * Este componente centraliza los colores. Acepta el slug en cualquier formato
 * (`fijo`, `Fijo`, `gasto_fijo`, `retiro socio`) y lo normaliza internamente.
 *
 * Paleta "pastel argentina" (suaves, no saturados):
 *   • fijo         → celeste pastel
 *   • variable     → beige/durazno
 *   • publicidad   → lila pastel
 *   • comision     → celeste medio
 *   • impuesto     → rosa pastel
 *   • retiro_socio → verde pastel
 *   • ingreso      → verde más oscuro (positivo)
 *   • default      → gris (cuando no matchea ningún tipo conocido)
 *
 * En dark mode los backgrounds se mantienen (son colores pastel suaves que
 * se ven bien sobre navy). Si se nota raro en algún caso, ajustar acá.
 */

interface TipoPillProps {
  tipo: string | undefined | null;
  size?: "sm" | "md";
}

const TIPO_COLORS: Record<string, { bg: string; fg: string }> = {
  fijo:         { bg: "#E2EEF7", fg: "#1A3A5E" },
  variable:     { bg: "#F7EAD6", fg: "#7A5D1A" },
  publicidad:   { bg: "#EBE0F2", fg: "#5D3A7A" },
  comision:     { bg: "#D7E8F5", fg: "#1A3A5E" },
  impuesto:     { bg: "#F5DDDD", fg: "#7A3A3A" },
  "retiro socio": { bg: "#E0F0DC", fg: "#3A6E3A" },
  ingreso:      { bg: "#D8EBC8", fg: "#2E5E2E" },
  cmv:          { bg: "#FCE4D6", fg: "#7A4A20" },
  default:      { bg: "var(--pase-celeste-100, #EAF3FB)", fg: "var(--pase-text-muted, #6E8CAB)" },
};

function normalizeTipo(raw: string | undefined | null): string {
  if (!raw) return "default";
  return raw.toLowerCase()
    .replace(/^gasto_/, "")
    .replace(/^cat_/, "")
    .replace(/_/g, " ")
    .trim();
}

function labelFor(normalized: string): string {
  // Capitalize palabras
  return normalized
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function TipoPill({ tipo, size = "sm" }: TipoPillProps) {
  const normalized = normalizeTipo(tipo);
  // noUncheckedIndexedAccess hace que TIPO_COLORS[normalized] sea posible
  // undefined — el fallback explícito al `default` (que SIEMPRE existe en
  // el record literal) garantiza valor non-null.
  const colors = TIPO_COLORS[normalized] ?? TIPO_COLORS.default!;
  const label = tipo ? labelFor(normalized) : "—";

  const padding = size === "md" ? "4px 10px" : "2px 8px";
  const fontSize = size === "md" ? 11 : 10;

  return (
    <span style={{
      display: "inline-block",
      padding,
      borderRadius: "var(--pase-radius-pill, 999px)",
      background: colors.bg,
      color: colors.fg,
      fontSize,
      fontWeight: 500,
      fontFamily: "var(--pase-font)",
      letterSpacing: "0.01em",
      whiteSpace: "nowrap",
      lineHeight: 1.4,
    }}>
      {label}
    </span>
  );
}
