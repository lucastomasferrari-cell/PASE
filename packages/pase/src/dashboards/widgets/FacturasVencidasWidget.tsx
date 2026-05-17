import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
import type { WidgetContext } from "../types";

interface FacturaVencida {
  id: number;
  proveedor_nombre: string | null;
  total: number;
  vencimiento: string;
  diasVencida: number;
}

// Widget: facturas vencidas (no pagadas con vencimiento < hoy).
// Crítico para compras y dueño/admin.
export function FacturasVencidasWidget({ ctx }: { ctx: WidgetContext }) {
  const [facturas, setFacturas] = useState<FacturaVencida[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function reload() {
      setLoading(true);
      const nowIso = new Date().toISOString().slice(0, 10);
      let q = db
        .from("facturas")
        .select("id, total, vencimiento, proveedores(razon_social)")
        .eq("pagada", false)
        .lt("vencimiento", nowIso)
        .order("vencimiento", { ascending: true })
        .limit(10);
      if (ctx.localActivo !== null) q = q.eq("local_id", ctx.localActivo);
      const { data, error } = await q;
      if (cancelled || error) { setLoading(false); return; }
      const today = Date.now();
      const mapped: FacturaVencida[] = (data ?? []).map(row => {
        const r = row as unknown as { id: number; total: number; vencimiento: string; proveedores: { razon_social: string } | null };
        const venc = new Date(r.vencimiento).getTime();
        return {
          id: r.id,
          proveedor_nombre: r.proveedores?.razon_social ?? null,
          total: Number(r.total ?? 0),
          vencimiento: r.vencimiento,
          diasVencida: Math.floor((today - venc) / (1000 * 60 * 60 * 24)),
        };
      });
      setFacturas(mapped);
      setLoading(false);
    }
    void reload();
    return () => { cancelled = true; };
  }, [ctx.localActivo]);

  if (loading) {
    return <div className="py-4 text-center text-xs text-pase-text-muted">Cargando…</div>;
  }

  if (facturas.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-pase-text-muted italic">
        Sin facturas vencidas. Buen trabajo.
      </div>
    );
  }

  const total = facturas.reduce((s, f) => s + f.total, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between pb-2 border-b border-pase-border">
        <span style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>
          {facturas.length} {facturas.length === 1 ? "factura vencida" : "facturas vencidas"}
        </span>
        <strong style={{ fontSize: "var(--pase-fs-lg)" }} className="text-red-700 tabular-nums">
          {formatCurrency(total)}
        </strong>
      </div>
      <div className="space-y-1.5 max-h-56 overflow-y-auto">
        {facturas.map(f => (
          <Link
            key={f.id}
            to={`/compras/facturas?id=${f.id}`}
            className="block p-2 rounded hover:bg-pase-bg-soft transition-colors"
            style={{ fontSize: "var(--pase-fs-base)" }}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium truncate">
                {f.proveedor_nombre ?? "(sin proveedor)"}
              </span>
              <strong className="tabular-nums text-red-700 flex-shrink-0">
                {formatCurrency(f.total)}
              </strong>
            </div>
            <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
              Vencida hace {f.diasVencida} día{f.diasVencida !== 1 ? "s" : ""}
            </div>
          </Link>
        ))}
      </div>
      <Link
        to="/compras/facturas?filtro=vencidas"
        className="block text-center pt-2 border-t border-pase-border text-pase-celeste hover:underline"
        style={{ fontSize: "var(--pase-fs-sm)" }}
      >
        Ver todas →
      </Link>
    </div>
  );
}
