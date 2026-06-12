/**
 * TipoPill — pill neutral por tipo de gasto / movimiento.
 *
 * Rediseño 2026-06-12: todos los tipos usan el mismo estilo neutral (muted).
 * El label comunica el tipo — no hace falta una paleta de 8 colores.
 */

interface TipoPillProps {
  tipo: string | undefined | null;
  size?: "sm" | "md";
}

const TIPO_COLORS: Record<string, { bg: string; fg: string }> = {
  default:      { bg: "var(--pase-bg-soft, #F0F4F8)", fg: "var(--pase-text-muted, #6E8CAB)" },
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
