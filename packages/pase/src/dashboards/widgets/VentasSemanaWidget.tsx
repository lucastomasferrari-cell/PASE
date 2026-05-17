import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { formatCurrency, formatCurrencyCompact } from "../../lib/format";
import { EmptyState } from "../../components/ui";
import type { WidgetContext } from "../types";

interface DiaVenta {
  fecha: string;     // YYYY-MM-DD
  diaLabel: string;  // L M X J V S D
  total: number;
}

interface Datos {
  dias: DiaVenta[];
  totalSemana: number;
  totalPrev: number;
  variacionPct: number | null;
}

const DOW = ["D", "L", "M", "X", "J", "V", "S"];

// Ventas últimos 7 días, comparado contra los 7 días anteriores.
// Sparkline visual + variación %. Útil para detectar tendencias mid-month
// sin necesidad de cierre contable.
export function VentasSemanaWidget({ ctx }: { ctx: WidgetContext }) {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function reload() {
      setLoading(true);
      const today = new Date();
      const ms = 24 * 60 * 60 * 1000;
      // Rango: 14 días atrás → hoy. Particionamos en 2 semanas.
      const desde = new Date(today.getTime() - 13 * ms).toISOString().slice(0, 10);
      const hasta = today.toISOString().slice(0, 10);
      let q = db
        .from("ventas")
        .select("fecha, monto")
        .gte("fecha", desde)
        .lte("fecha", hasta)
        .neq("estado", "anulada");
      if (ctx.localActivo !== null) q = q.eq("local_id", ctx.localActivo);
      const { data, error } = await q;
      if (cancelled || error) { setLoading(false); return; }

      const totalPorFecha = new Map<string, number>();
      for (const r of data ?? []) {
        const row = r as { fecha: string; monto: number };
        totalPorFecha.set(row.fecha, (totalPorFecha.get(row.fecha) ?? 0) + Number(row.monto ?? 0));
      }

      const dias: DiaVenta[] = [];
      let totalSemana = 0;
      let totalPrev = 0;
      for (let i = 13; i >= 0; i--) {
        const d = new Date(today.getTime() - i * ms);
        const fecha = d.toISOString().slice(0, 10);
        const total = totalPorFecha.get(fecha) ?? 0;
        if (i < 7) {
          totalSemana += total;
          dias.push({ fecha, diaLabel: DOW[d.getDay()] ?? "?", total });
        } else {
          totalPrev += total;
        }
      }
      const variacionPct = totalPrev > 0 ? ((totalSemana - totalPrev) / totalPrev) * 100 : null;
      setDatos({ dias, totalSemana, totalPrev, variacionPct });
      setLoading(false);
    }
    void reload();
    return () => { cancelled = true; };
  }, [ctx.localActivo]);

  if (loading) {
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  if (!datos || datos.totalSemana === 0) {
    return (
      <EmptyState
        icon="📈"
        title="Sin ventas en la semana"
        description="Cuando se carguen ventas vas a ver la tendencia acá."
        size="compact"
      />
    );
  }

  const maxDia = Math.max(1, ...datos.dias.map(d => d.total));
  const variacion = datos.variacionPct;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: "var(--pase-fs-2xl)", fontWeight: 500, fontVariantNumeric: "tabular-nums", letterSpacing: "var(--pase-ls-tight)", color: "var(--pase-text)", lineHeight: 1.1 }}>
            {formatCurrency(datos.totalSemana)}
          </div>
          <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", marginTop: 4 }}>
            últimos 7 días
          </div>
        </div>
        {variacion !== null && (
          <div style={{ textAlign: "right" }}>
            <div style={{
              fontSize: "var(--pase-fs-lg)",
              fontWeight: 500,
              color: variacion >= 0 ? "var(--pase-celeste)" : "var(--pase-text-muted)",
              fontVariantNumeric: "tabular-nums",
            }}>
              {variacion >= 0 ? "+" : ""}{variacion.toFixed(1)}%
            </div>
            <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginTop: 2 }}>
              vs semana previa
            </div>
          </div>
        )}
      </div>
      {/* Sparkline */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 60, marginTop: 4 }}>
        {datos.dias.map((d, i) => {
          const pct = Math.max(4, Math.round((d.total / maxDia) * 100));
          return (
            <div key={d.fecha} title={`${d.diaLabel} — ${formatCurrencyCompact(d.total)}`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{
                width: "100%",
                height: `${pct}%`,
                background: i === datos.dias.length - 1 ? "var(--pase-celeste)" : "var(--pase-celeste-200)",
                borderRadius: "3px 3px 0 0",
                transition: "background 0.15s",
              }} />
              <span style={{ fontSize: 10, color: "var(--pase-text-muted)", fontWeight: 500 }}>{d.diaLabel}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
