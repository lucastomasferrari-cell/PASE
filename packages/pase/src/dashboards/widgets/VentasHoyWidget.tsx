import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
import type { WidgetContext } from "../types";

interface UltimaVenta {
  fecha: string;
  monto: number;
  turno: string | null;
  local_id: number | null;
}

// Ventas registradas hoy. Si no hay ventas hoy, mostramos las últimas 2
// (decisión Lucas 2026-05-17: "sin ventas hoy" es ruido — mostrar lo más
// reciente es más útil).
export function VentasHoyWidget({ ctx }: { ctx: WidgetContext }) {
  const [data, setData] = useState<{ total: number; count: number; ultimas: UltimaVenta[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function reload() {
      setLoading(true);
      const today = new Date().toISOString().slice(0, 10);

      // Query 1: ventas de hoy (con count para evitar agregación client-side cuando hay muchas).
      let qHoy = db
        .from("ventas")
        .select("monto", { count: "exact" })
        .eq("fecha", today);
      if (ctx.localActivo !== null) qHoy = qHoy.eq("local_id", ctx.localActivo);
      const { data: rowsHoy, count, error } = await qHoy;
      if (cancelled || error) { setLoading(false); return; }
      const total = (rowsHoy ?? []).reduce((s, r) => s + Number((r as { monto: number }).monto ?? 0), 0);

      // Si no hay ventas hoy, traemos las últimas 2 (por local activo o consolidado).
      let ultimas: UltimaVenta[] = [];
      if ((count ?? 0) === 0) {
        let qUlt = db
          .from("ventas")
          .select("fecha, monto, turno, local_id")
          .order("fecha", { ascending: false })
          .order("id", { ascending: false })
          .limit(2);
        if (ctx.localActivo !== null) qUlt = qUlt.eq("local_id", ctx.localActivo);
        const { data: ultRows } = await qUlt;
        ultimas = (ultRows ?? []) as UltimaVenta[];
      }

      setData({ total, count: count ?? 0, ultimas });
      setLoading(false);
    }
    void reload();
    return () => { cancelled = true; };
  }, [ctx.localActivo]);

  if (loading) {
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  // Caso sin ventas hoy → mostrar las últimas 2 (más útil que un empty state plano)
  if (!data || data.count === 0) {
    return (
      <div>
        <div style={{
          fontSize: "var(--pase-fs-md)",
          color: "var(--pase-text-muted)",
          fontWeight: 500,
          marginBottom: 10,
        }}>
          Sin ventas hoy todavía
        </div>
        {data && data.ultimas.length > 0 ? (
          <>
            <div style={{
              fontSize: "var(--pase-fs-xs)",
              color: "var(--pase-text-muted)",
              textTransform: "uppercase",
              letterSpacing: "var(--pase-ls-overline)",
              marginBottom: 6,
            }}>
              Últimas ventas
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {data.ultimas.map((v, i) => {
                const nombreLocal = v.local_id ? ctx.locales.find(l => l.id === v.local_id)?.nombre : null;
                return (
                  <div key={i} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8,
                    padding: "8px 10px",
                    background: "var(--pase-bg-soft)",
                    borderRadius: 6,
                    fontSize: "var(--pase-fs-sm)",
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: "var(--pase-text)", fontWeight: 500 }}>
                        {fmtFechaRel(v.fecha)}{v.turno ? ` · ${v.turno}` : ""}
                      </div>
                      {ctx.localActivo === null && nombreLocal && (
                        <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
                          {nombreLocal}
                        </div>
                      )}
                    </div>
                    <strong style={{ fontVariantNumeric: "tabular-nums", color: "var(--pase-text)" }}>
                      {formatCurrency(v.monto)}
                    </strong>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", fontStyle: "italic" }}>
            No hay ventas registradas todavía.
          </div>
        )}
      </div>
    );
  }

  // Caso con ventas hoy → KPI grande
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

function fmtFechaRel(fechaISO: string): string {
  const f = new Date(`${fechaISO}T12:00:00`);
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const ayer = new Date(hoy);
  ayer.setDate(ayer.getDate() - 1);
  const fStart = new Date(f);
  fStart.setHours(0, 0, 0, 0);
  if (fStart.getTime() === ayer.getTime()) return "Ayer";
  const diffDias = Math.round((hoy.getTime() - fStart.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDias < 7) return `Hace ${diffDias} días`;
  return f.toLocaleDateString("es-AR", { day: "2-digit", month: "short" });
}
