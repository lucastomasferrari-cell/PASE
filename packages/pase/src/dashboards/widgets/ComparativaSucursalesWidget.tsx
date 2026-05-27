import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
import { EmptyState, ShopIcon } from "../../components/ui";
import type { WidgetContext } from "../types";
import { now, todayAR_ISO, toLocalISO } from '../../lib/utils';

interface LocalRow {
  id: number;
  nombre: string;
  totalSemana: number;
}

// Ranking de sucursales por ventas de los últimos 7 días.
//
// Estrategia robusta (2026-05-17): NO dependemos de ctx.locales para la query
// de ventas — dejamos que RLS limite a las sucursales del tenant. Después
// resolvemos los nombres consultando `locales` directamente. Esto evita
// problemas si ctx.locales viene vacío en el primer render del DashboardHome.
//
// Si el dueño/admin tiene 0 o 1 sucursales visibles, no se puede armar ranking.
export function ComparativaSucursalesWidget({ ctx }: { ctx: WidgetContext }) {
  const [rows, setRows] = useState<LocalRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function reload() {
      setLoading(true);
      const today = now();
      const desde = toLocalISO(new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000));
      const hasta = todayAR_ISO();

      // Traer ventas + nombres de locales en paralelo (ambos limitados por RLS).
      // Sin filtro estado (Maxirest no lo setea — sería NULL y NEQ excluye).
      const [ventasRes, localesRes] = await Promise.all([
        // eslint-disable-next-line pase-local/require-apply-local-scope -- widget de COMPARATIVA: necesita ver ventas de TODOS los locales del tenant para comparar. RLS sigue scopeando al tenant.
        db.from("ventas")
          .select("local_id, monto")
          .gte("fecha", desde)
          .lte("fecha", hasta),
        db.from("locales").select("id, nombre").order("nombre"),
      ]);

      if (cancelled) return;
      if (ventasRes.error || localesRes.error) { setLoading(false); return; }

      const locales = (localesRes.data ?? []) as Array<{ id: number; nombre: string }>;
      const totalPorLocal = new Map<number, number>();
      for (const r of ventasRes.data ?? []) {
        const row = r as { local_id: number; monto: number };
        totalPorLocal.set(row.local_id, (totalPorLocal.get(row.local_id) ?? 0) + Number(row.monto ?? 0));
      }
      const mapped: LocalRow[] = locales.map(l => ({
        id: l.id,
        nombre: l.nombre,
        totalSemana: totalPorLocal.get(l.id) ?? 0,
      })).sort((a, b) => b.totalSemana - a.totalSemana);
      setRows(mapped);
      setLoading(false);
    }
    void reload();
    return () => { cancelled = true; };
  }, [ctx.localActivo]);

  if (loading) {
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  if (rows.length < 2) {
    return (
      <EmptyState
        icon={<ShopIcon size={32} tone="muted" />}
        title="Necesitás 2+ sucursales"
        description="El ranking aparece cuando tenés más de un local cargado."
        size="compact"
      />
    );
  }

  const max = Math.max(1, ...rows.map(l => l.totalSemana));

  return (
    <div>
      <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", marginBottom: 10 }}>
        Ranking · últimos 7 días
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.map((l, idx) => {
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
