import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
import { EmptyState } from "../../components/ui";
import type { WidgetContext } from "../types";

interface LocalRow {
  id: number;
  nombre: string;
  totalSemana: number;
}

// Ranking de sucursales por ventas de los últimos 7 días.
// Solo aparece cuando el dueño/admin tiene >1 local visible. Si solo tiene
// uno, no aporta valor (no hay con qué comparar).
export function ComparativaSucursalesWidget({ ctx }: { ctx: WidgetContext }) {
  const [locales, setLocales] = useState<LocalRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function reload() {
      setLoading(true);
      if (ctx.locales.length < 2) {
        setLocales([]);
        setLoading(false);
        return;
      }
      const today = new Date();
      const desde = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const hasta = today.toISOString().slice(0, 10);
      const { data, error } = await db
        .from("ventas")
        .select("local_id, total")
        .gte("fecha", desde)
        .lte("fecha", hasta)
        .eq("anulada", false)
        .in("local_id", ctx.locales.map(l => l.id));
      if (cancelled || error) { setLoading(false); return; }
      const totalPorLocal = new Map<number, number>();
      for (const r of data ?? []) {
        const row = r as { local_id: number; total: number };
        totalPorLocal.set(row.local_id, (totalPorLocal.get(row.local_id) ?? 0) + Number(row.total ?? 0));
      }
      const rows: LocalRow[] = ctx.locales.map(l => ({
        id: l.id,
        nombre: l.nombre,
        totalSemana: totalPorLocal.get(l.id) ?? 0,
      })).sort((a, b) => b.totalSemana - a.totalSemana);
      setLocales(rows);
      setLoading(false);
    }
    void reload();
    return () => { cancelled = true; };
  }, [ctx.localActivo, ctx.locales]);

  if (loading) {
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  if (locales.length < 2) {
    return (
      <EmptyState
        icon="🏪"
        title="Necesitás 2+ sucursales"
        description="El ranking aparece cuando tenés más de un local cargado."
        size="compact"
      />
    );
  }

  const max = Math.max(1, ...locales.map(l => l.totalSemana));

  return (
    <div>
      <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", marginBottom: 10 }}>
        Ranking · últimos 7 días
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {locales.map((l, idx) => {
          const pct = Math.max(2, Math.round((l.totalSemana / max) * 100));
          return (
            <div key={l.id}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: "var(--pase-fs-base)", color: "var(--pase-text)", display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-xs)", fontVariantNumeric: "tabular-nums", minWidth: 14 }}>{idx + 1}.</span>
                  {l.nombre}
                </span>
                <strong style={{ fontSize: "var(--pase-fs-base)", fontVariantNumeric: "tabular-nums" }}>
                  {formatCurrency(l.totalSemana)}
                </strong>
              </div>
              <div style={{ width: "100%", height: 4, background: "var(--pase-bg-soft)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: idx === 0 ? "var(--pase-celeste)" : "var(--pase-celeste-300)",
                  transition: "width 0.2s ease",
                }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
