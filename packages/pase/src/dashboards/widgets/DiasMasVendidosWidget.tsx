import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
import type { WidgetContext } from "../types";
import { now, toLocalISO } from "@pase/shared/utils";

interface DiaSemana { dia: string; total: number }

const DOW_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

// Días de la semana que más se vende (últimos 90 días, ranking con barras).
// Extraído de Finanzas.tsx en el rediseño 11-jun (fusión Negocio+Finanzas)
// para que viva como widget registrado.
export function DiasMasVendidosWidget({ ctx }: { ctx: WidgetContext }) {
  const [data, setData] = useState<DiaSemana[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const today = now();
      const desde = toLocalISO(new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000));
      const hasta = toLocalISO(today);
      // `ventas` NO tiene columna `estado` (las anuladas se eliminan via RPC
      // eliminar_venta) — filtrar por estado hacía fallar la query entera y
      // el widget quedaba vacío en silencio (bug detectado 12-jun).
      let q = db
        .from("ventas")
        .select("fecha, monto")
        .gte("fecha", desde)
        .lte("fecha", hasta);
      if (ctx.localActivo !== null) q = q.eq("local_id", ctx.localActivo);
      const { data: rows, error } = await q;
      if (cancelled || error) { setLoading(false); return; }
      const porDow = Array(7).fill(0);
      for (const r of rows ?? []) {
        const row = r as { fecha: string; monto: number };
        // Parse fecha (YYYY-MM-DD) preservando local day-of-week. usar T12:00 para evitar TZ shifts.
        const dow = new Date(`${row.fecha}T12:00:00`).getDay();
        porDow[dow] += Number(row.monto ?? 0);
      }
      const arr: DiaSemana[] = porDow.map((total, idx) => ({ dia: DOW_LABELS[idx] ?? "?", total }));
      // Ordenar de mayor a menor
      arr.sort((a, b) => b.total - a.total);
      if (!cancelled) setData(arr);
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [ctx.localActivo]);

  if (loading) return <div style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)", textAlign: "center", padding: 16 }}>Cargando…</div>;
  if (!data || data.every(d => d.total === 0)) {
    return <div style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)", textAlign: "center", padding: 16, fontStyle: "italic" }}>Sin ventas en 90 días</div>;
  }

  const max = Math.max(1, ...data.map(d => d.total));
  return (
    <div>
      <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginBottom: 10 }}>
        Últimos 90 días
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {data.map(d => {
          const pct = Math.max(2, Math.round((d.total / max) * 100));
          return (
            <div key={d.dia}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 2 }}>
                <span style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text)", minWidth: 36 }}>{d.dia}</span>
                <span style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                  {formatCurrency(d.total)}
                </span>
              </div>
              <div style={{ width: "100%", height: 4, background: "var(--pase-bg-soft)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: "var(--pase-celeste-300)" }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
