import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
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
      let q = db
        .from("ventas")
        .select("total", { count: "exact" })
        .eq("fecha", today)
        .eq("anulada", false);
      if (ctx.localActivo !== null) q = q.eq("local_id", ctx.localActivo);
      const { data: rows, count, error } = await q;
      if (cancelled || error) { setLoading(false); return; }
      const total = (rows ?? []).reduce((s, r) => s + Number((r as { total: number }).total ?? 0), 0);
      setData({ total, count: count ?? 0 });
      setLoading(false);
    }
    void reload();
    return () => { cancelled = true; };
  }, [ctx.localActivo]);

  if (loading) {
    return <div className="py-4 text-center text-xs text-pase-text-muted">Cargando…</div>;
  }

  if (!data || data.count === 0) {
    return (
      <div className="py-6 text-center text-xs text-pase-text-muted italic">
        Sin ventas registradas hoy todavía.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        className="font-medium tabular-nums"
        style={{ fontSize: "var(--pase-fs-2xl)", letterSpacing: "var(--pase-ls-tight)" }}
      >
        {formatCurrency(data.total)}
      </div>
      <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>
        {data.count} {data.count === 1 ? "venta" : "ventas"} hoy
      </div>
    </div>
  );
}
