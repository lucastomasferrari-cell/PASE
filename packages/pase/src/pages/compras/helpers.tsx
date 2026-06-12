// Helpers de UI del módulo Compras. Extraídos en F9 split (2026-05-11).

export function estadoDot(estado: string) {
  const config: Record<string, { dot: string; bg: string; text: string }> = {
    pendiente: { dot: "#D97706", bg: "rgba(217,119,6,0.08)", text: "#D97706" },
    vencida:   { dot: "#DC2626", bg: "rgba(220,38,38,0.08)", text: "#DC2626" },
    pagada:    { dot: "var(--pase-celeste)", bg: "var(--pase-celeste-100)", text: "var(--pase-text)" },
    anulada:   { dot: "var(--pase-text-muted)", bg: "var(--pase-bg-out)", text: "var(--pase-text-muted)" },
    revision:  { dot: "var(--pase-gold)", bg: "rgba(245,197,24,0.1)", text: "#D97706" },
  };
  const labels: Record<string,string> = {
    pendiente: "Pendiente",
    vencida:   "Vencida",
    pagada:    "Pagada",
    anulada:   "Anulada",
    revision:  "Revisión",
  };
  const c = config[estado] || { dot: "var(--pase-text-muted)", bg: "var(--pase-bg-out)", text: "var(--pase-text-muted)" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      fontSize: "var(--pase-fs-xs)", fontWeight: 500, letterSpacing: "0.02em",
      color: c.text, background: c.bg,
      padding: "3px 10px 3px 8px", borderRadius: 999,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot, flexShrink: 0 }} />
      {labels[estado] || estado}
    </span>
  );
}
