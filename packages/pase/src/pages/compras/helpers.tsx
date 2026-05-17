// Helpers de UI del módulo Compras. Extraídos en F9 split (2026-05-11).

export function estadoDot(estado: string) {
  // Colores del dot — usamos tonos firmes para que se vean en dark:
  // - pendiente: dorado muted (warning) — espera acción
  // - vencida:  rojo/coral firme — atención inmediata
  // - pagada:   celeste (success en sistema PASE)
  // - anulada:  muted apagado con tachado
  // - revision: dorado fuerte
  const dotColors: Record<string,string> = {
    pendiente: "#D97706",
    vencida:   "#DC2626",
    pagada:    "var(--pase-celeste)",
    anulada:   "var(--pase-text-muted)",
    revision:  "var(--pase-gold)",
  };
  const labels: Record<string,string> = {
    pendiente: "Pendiente",
    vencida:   "Vencida",
    pagada:    "Pagada",
    anulada:   "Anulada",
    revision:  "⚠ Revisión",
  };
  // Texto: var(--pase-text) (legible en ambos modos) salvo anulada que va apagada.
  const textColor = estado === "anulada" ? "var(--pase-text-muted)" : "var(--pase-text)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--pase-fs-sm)", color: textColor, fontWeight: 500 }}>
      <div style={{ width: 7, height: 7, borderRadius: "50%", background: dotColors[estado] || "var(--pase-text-muted)", flexShrink: 0 }} />
      {labels[estado] || estado}
    </div>
  );
}
