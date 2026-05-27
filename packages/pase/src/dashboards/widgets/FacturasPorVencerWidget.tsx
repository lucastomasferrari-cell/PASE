import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
import { EmptyState, CalendarIcon } from "../../components/ui";
import type { WidgetContext } from "../types";
import { now, todayAR_ISO, toLocalISO } from '../../lib/utils';

interface FacturaProx {
  id: number;
  proveedor_nombre: string | null;
  total: number;
  vencimiento: string;
  diasRestantes: number;
}

// Facturas no pagadas con vencimiento dentro de los próximos 7 días.
// Avisa al área de Compras qué se viene encima — ventana corta de planificación.
export function FacturasPorVencerWidget({ ctx }: { ctx: WidgetContext }) {
  const [facturas, setFacturas] = useState<FacturaProx[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function reload() {
      setLoading(true);
      const today = now();
      const todayIso = todayAR_ISO();
      const in7 = toLocalISO(new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000));
      // Schema real: columna `venc` (no `vencimiento`) y `estado` IN
      // ('pendiente','pagada','anulada') — no hay boolean `pagada`. Fix 2026-05-17.
      let q = db
        .from("facturas")
        .select("id, total, venc, proveedores(nombre)")
        .eq("estado", "pendiente")
        .gte("venc", todayIso)
        .lte("venc", in7)
        .order("venc", { ascending: true })
        .limit(15);
      if (ctx.localActivo !== null) q = q.eq("local_id", ctx.localActivo);
      const { data, error } = await q;
      if (cancelled || error) { setLoading(false); return; }
      const nowMs = today.getTime();
      const mapped: FacturaProx[] = (data ?? []).map(row => {
        const r = row as unknown as { id: number; total: number; venc: string; proveedores: { nombre: string } | null };
        const venc = new Date(r.venc).getTime();
        return {
          id: r.id,
          proveedor_nombre: r.proveedores?.nombre ?? null,
          total: Number(r.total ?? 0),
          vencimiento: r.venc,
          diasRestantes: Math.max(0, Math.ceil((venc - nowMs) / (1000 * 60 * 60 * 24))),
        };
      });
      setFacturas(mapped);
      setLoading(false);
    }
    void reload();
    return () => { cancelled = true; };
  }, [ctx.localActivo]);

  if (loading) {
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  if (facturas.length === 0) {
    return (
      <EmptyState
        icon={<CalendarIcon size={32} tone="muted" />}
        title="Nada vence en los próximos 7 días"
        description="Tranquilo, sin pagos urgentes a la vista."
        size="compact"
      />
    );
  }

  const total = facturas.reduce((s, f) => s + f.total, 0);

  return (
    <div>
      <div style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        paddingBottom: 8,
        borderBottom: "0.5px solid var(--pase-border)",
        marginBottom: 8,
      }}>
        <span style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>
          {facturas.length} {facturas.length === 1 ? "factura" : "facturas"} en 7 días
        </span>
        <strong style={{ fontSize: "var(--pase-fs-lg)", fontVariantNumeric: "tabular-nums", color: "var(--pase-text)" }}>
          {formatCurrency(total)}
        </strong>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 224, overflowY: "auto" }}>
        {facturas.map(f => (
          <Link
            key={f.id}
            to={`/compras/facturas?id=${f.id}`}
            style={{
              display: "block",
              padding: 8,
              borderRadius: 6,
              textDecoration: "none",
              color: "var(--pase-text)",
              fontSize: "var(--pase-fs-base)",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--pase-bg-soft)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.proveedor_nombre ?? "(sin proveedor)"}
              </span>
              <strong style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                {formatCurrency(f.total)}
              </strong>
            </div>
            <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
              {f.diasRestantes === 0 ? "Vence hoy" : f.diasRestantes === 1 ? "Vence mañana" : `En ${f.diasRestantes} días`}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
