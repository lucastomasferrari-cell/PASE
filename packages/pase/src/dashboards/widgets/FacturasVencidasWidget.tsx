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
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  if (facturas.length === 0) {
    return (
      <div style={{ padding: "20px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)", fontStyle: "italic" }}>
        Sin facturas vencidas. Buen trabajo.
      </div>
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
          {facturas.length} {facturas.length === 1 ? "factura vencida" : "facturas vencidas"}
        </span>
        <strong style={{ fontSize: "var(--pase-fs-lg)", color: "#B91C1C", fontVariantNumeric: "tabular-nums" }}>
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
              <strong style={{ fontVariantNumeric: "tabular-nums", color: "#B91C1C", flexShrink: 0 }}>
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
        style={{
          display: "block",
          textAlign: "center",
          paddingTop: 8,
          marginTop: 8,
          borderTop: "0.5px solid var(--pase-border)",
          color: "var(--pase-celeste)",
          fontSize: "var(--pase-fs-sm)",
          textDecoration: "none",
        }}
      >
        Ver todas →
      </Link>
    </div>
  );
}
