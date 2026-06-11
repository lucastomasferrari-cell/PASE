import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { formatCurrencyCompact } from "../../lib/format";
import type { WidgetContext } from "../types";
import { now, toLocalISO } from "@pase/shared/utils";

interface MesData { mesLabel: string; total: number }

// Ventas mes a mes (últimos 6 meses, barras). Extraído de Finanzas.tsx en el
// rediseño 11-jun (fusión Negocio+Finanzas) para que viva como widget
// registrado: la pantalla Negocio lo usa fijo y cualquier usuario puede
// sumarlo a su Inicio desde Configurar dashboards.
export function VentasMesAMesWidget({ ctx }: { ctx: WidgetContext }) {
  const [data, setData] = useState<MesData[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const today = now();
      // 6 meses atrás (primer día) → hoy
      const desde = new Date(today.getFullYear(), today.getMonth() - 5, 1);
      const desdeIso = toLocalISO(desde);
      const hastaIso = toLocalISO(today);
      let q = db
        .from("ventas")
        .select("fecha, monto")
        .gte("fecha", desdeIso)
        .lte("fecha", hastaIso);
      if (ctx.localActivo !== null) q = q.eq("local_id", ctx.localActivo);
      const { data: rows, error } = await q;
      if (cancelled || error) { setLoading(false); return; }
      const porMes = new Map<string, number>();
      for (const r of rows ?? []) {
        const row = r as { fecha: string; monto: number };
        const mesKey = row.fecha.slice(0, 7); // YYYY-MM
        porMes.set(mesKey, (porMes.get(mesKey) ?? 0) + Number(row.monto ?? 0));
      }
      const meses: MesData[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const mesKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        meses.push({
          mesLabel: d.toLocaleDateString("es-AR", { month: "short" }),
          total: porMes.get(mesKey) ?? 0,
        });
      }
      if (!cancelled) setData(meses);
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [ctx.localActivo]);

  if (loading) return <div style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)", textAlign: "center", padding: 16 }}>Cargando…</div>;
  if (!data || data.every(m => m.total === 0)) {
    return <div style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)", textAlign: "center", padding: 16, fontStyle: "italic" }}>Sin ventas en los últimos 6 meses</div>;
  }
  const max = Math.max(1, ...data.map(m => m.total));
  const mesActualIdx = data.length - 1;
  return (
    <div>
      {/* Altura de barra en PX, no %: la columna intermedia (valor + barra +
          mes apilados) tiene altura auto, así que `height: N%` resolvía a 0
          y las barras eran invisibles — bug heredado de la ex-Finanzas,
          reportado por Lucas 11-jun. */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 120 }}>
        {data.map((m, i) => {
          const barPx = Math.max(4, Math.round((m.total / max) * 72));
          return (
            <div key={m.mesLabel + i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 4 }} title={`${m.mesLabel} — ${formatCurrencyCompact(m.total)}`}>
              <span style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                {formatCurrencyCompact(m.total)}
              </span>
              <div style={{
                width: "100%",
                height: barPx,
                background: i === mesActualIdx ? "var(--pase-celeste)" : "var(--pase-celeste-200)",
                borderRadius: "4px 4px 0 0",
              }} />
              <span style={{ fontSize: 10, color: "var(--pase-text-muted)", textTransform: "capitalize" }}>{m.mesLabel}</span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginTop: 8, textAlign: "center" }}>
        Mes actual va parcial · barras anteriores son meses completos
      </div>
    </div>
  );
}
