import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
import { CheckIcon } from "../../components/ui";
import type { WidgetContext } from "../types";

interface FacturaVencida {
  id: number;
  proveedor_nombre: string | null;
  total: number;
  vencimiento: string;
  diasVencida: number;
}

interface FacturaUltimaPagada {
  id: number;
  proveedor_nombre: string | null;
  total: number;
  fecha: string;
}

// Widget: facturas vencidas (no pagadas con vencimiento < hoy).
// Si NO hay vencidas, mostramos las últimas 3 pagadas (más útil que un
// empty state plano). Decisión Lucas 2026-05-17: "es más útil ver qué
// pasó hace poco que decir 'todo al día'".
export function FacturasVencidasWidget({ ctx }: { ctx: WidgetContext }) {
  const [vencidas, setVencidas] = useState<FacturaVencida[]>([]);
  const [ultimasPagadas, setUltimasPagadas] = useState<FacturaUltimaPagada[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function reload() {
      setLoading(true);
      const nowIso = new Date().toISOString().slice(0, 10);
      // Query 1: vencidas (pendientes con venc < hoy)
      let qVenc = db
        .from("facturas")
        .select("id, total, venc, proveedores(razon_social)")
        .eq("estado", "pendiente")
        .lt("venc", nowIso)
        .order("venc", { ascending: true })
        .limit(10);
      if (ctx.localActivo !== null) qVenc = qVenc.eq("local_id", ctx.localActivo);
      const { data: vData, error: vErr } = await qVenc;
      if (cancelled || vErr) { setLoading(false); return; }
      const today = Date.now();
      const vMapped: FacturaVencida[] = (vData ?? []).map(row => {
        const r = row as unknown as { id: number; total: number; venc: string; proveedores: { razon_social: string } | null };
        const venc = new Date(r.venc).getTime();
        return {
          id: r.id,
          proveedor_nombre: r.proveedores?.razon_social ?? null,
          total: Number(r.total ?? 0),
          vencimiento: r.venc,
          diasVencida: Math.floor((today - venc) / (1000 * 60 * 60 * 24)),
        };
      });
      setVencidas(vMapped);

      // Si no hay vencidas, traemos las últimas 3 pagadas
      if (vMapped.length === 0) {
        let qPag = db
          .from("facturas")
          .select("id, total, fecha, proveedores(razon_social)")
          .eq("estado", "pagada")
          .order("fecha", { ascending: false })
          .limit(3);
        if (ctx.localActivo !== null) qPag = qPag.eq("local_id", ctx.localActivo);
        const { data: pData } = await qPag;
        const pMapped: FacturaUltimaPagada[] = (pData ?? []).map(row => {
          const r = row as unknown as { id: number; total: number; fecha: string; proveedores: { razon_social: string } | null };
          return {
            id: r.id,
            proveedor_nombre: r.proveedores?.razon_social ?? null,
            total: Number(r.total ?? 0),
            fecha: r.fecha,
          };
        });
        setUltimasPagadas(pMapped);
      }
      setLoading(false);
    }
    void reload();
    return () => { cancelled = true; };
  }, [ctx.localActivo]);

  if (loading) {
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  // Sin vencidas → mostrar últimas pagadas
  if (vencidas.length === 0) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <CheckIcon size={20} tone="gold" />
          <span style={{ fontSize: "var(--pase-fs-md)", fontWeight: 500, color: "var(--pase-text)" }}>
            Todas al día
          </span>
        </div>
        {ultimasPagadas.length > 0 && (
          <>
            <div style={{
              fontSize: "var(--pase-fs-xs)",
              color: "var(--pase-text-muted)",
              textTransform: "uppercase",
              letterSpacing: "var(--pase-ls-overline)",
              marginBottom: 6,
            }}>
              Últimas pagadas
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {ultimasPagadas.map(f => (
                <Link
                  key={f.id}
                  to={`/compras/facturas?id=${f.id}`}
                  style={{
                    display: "block",
                    padding: "8px 10px",
                    borderRadius: 6,
                    background: "var(--pase-bg-soft)",
                    textDecoration: "none",
                    fontSize: "var(--pase-fs-sm)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ color: "var(--pase-text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.proveedor_nombre ?? "(sin proveedor)"}
                    </span>
                    <strong style={{ fontVariantNumeric: "tabular-nums", color: "var(--pase-text)", flexShrink: 0 }}>
                      {formatCurrency(f.total)}
                    </strong>
                  </div>
                  <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
                    {fmtFechaRel(f.fecha)}
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  const total = vencidas.reduce((s, f) => s + f.total, 0);

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
          {vencidas.length} {vencidas.length === 1 ? "factura vencida" : "facturas vencidas"}
        </span>
        <strong style={{ fontSize: "var(--pase-fs-lg)", color: "#B91C1C", fontVariantNumeric: "tabular-nums" }}>
          {formatCurrency(total)}
        </strong>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 224, overflowY: "auto" }}>
        {vencidas.map(f => (
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

function fmtFechaRel(fechaISO: string): string {
  const f = new Date(`${fechaISO}T12:00:00`);
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const fStart = new Date(f);
  fStart.setHours(0, 0, 0, 0);
  const diffDias = Math.round((hoy.getTime() - fStart.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDias === 0) return "Hoy";
  if (diffDias === 1) return "Ayer";
  if (diffDias < 7) return `Hace ${diffDias} días`;
  return f.toLocaleDateString("es-AR", { day: "2-digit", month: "short" });
}
