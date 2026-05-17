import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
import { EmptyState, TrendUpIcon } from "../../components/ui";
import type { WidgetContext } from "../types";

// Ventas registradas hoy (tabla `ventas`). Cantidad + total.
export function VentasHoyWidget({ ctx }: { ctx: WidgetContext }) {
  const [data, setData] = useState<{ total: number; count: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function reload() {
      setLoading(true);
      const today = new Date().toISOString().slice(0, 10);
      // No filtro por estado=anulada porque Maxirest no setea ese campo
      // (queda NULL) y .neq excluiría TODOS los rows en SQL (NULL != X = UNKNOWN).
      // Las ventas anuladas son minoría — preferimos sobre-contar a no mostrar nada.
      let q = db
        .from("ventas")
        .select("monto", { count: "exact" })
        .eq("fecha", today);
      if (ctx.localActivo !== null) q = q.eq("local_id", ctx.localActivo);
      const { data: rows, count, error } = await q;
      if (cancelled || error) { setLoading(false); return; }
      const total = (rows ?? []).reduce((s, r) => s + Number((r as { monto: number }).monto ?? 0), 0);
      setData({ total, count: count ?? 0 });
      setLoading(false);
    }
    void reload();
    return () => { cancelled = true; };
  }, [ctx.localActivo]);

  if (loading) {
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  if (!data || data.count === 0) {
    return (
      <EmptyState
        icon={<TrendUpIcon size={32} tone="muted" />}
        title="Sin ventas hoy todavía"
        description="Cuando se registren ventas las vas a ver acá."
        size="compact"
      />
    );
  }

  return (
    <div>
      <div style={{
        fontSize: "var(--pase-fs-2xl)",
        fontWeight: 500,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "var(--pase-ls-tight)",
        color: "var(--pase-text)",
        lineHeight: 1.1,
      }}>
        {formatCurrency(data.total)}
      </div>
      <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", marginTop: 6 }}>
        {data.count} {data.count === 1 ? "venta" : "ventas"} hoy
      </div>
    </div>
  );
}
