// Helpers de UI del módulo Compras. Extraídos en F9 split (2026-05-11).

export function estadoDot(estado: string) {
  const colors: Record<string,string> = { pendiente: "var(--muted2)", vencida: "var(--acc)", pagada: "var(--success)", revision: "var(--warn)" };
  const labels: Record<string,string> = { pendiente: "Pendiente", vencida: "Vencida", pagada: "Pagada", anulada: "Anulada", revision: "⚠ Revisión" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: estado === "revision" ? "var(--warn)" : "var(--muted2)" }}>
      <div style={{ width: 5, height: 5, borderRadius: "50%", background: colors[estado] || "var(--bd2)", flexShrink: 0 }} />
      {labels[estado] || estado}
    </div>
  );
}
