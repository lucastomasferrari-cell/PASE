// PASE V2 — Ventas
//
// Listado de ventas + KPIs del período + ranking por medio de cobro.
// Acción "Cargar venta" → modal con form rápido.
//
// Spec: docs/superpowers/specs/2026-05-28-ventas-pos-comanda-rediseno.md

import { useEffect, useState, useMemo } from "react";
import { db } from "../../lib/supabase";
import { useAuth, applyLocalScope } from "../../lib/auth";
import { Plus, TrendingUp, ShoppingBag, DollarSign, Filter } from "lucide-react";
import { Button } from "../../components/v2/Button";
import { Badge } from "../../components/v2/Badge";
import { StatCard } from "../../components/v2/StatCard";
import { PageHeader } from "../../components/v2/PageHeader";
import { Select } from "../../components/v2/Select";

interface Venta {
  id: number;
  fecha: string;
  monto: number;
  medio_cobro: string;
  detalle: string | null;
  local_id: number;
}

interface Props {
  localActivo: number | null;
}

const PERIODOS = {
  hoy: 0,
  semana: 7,
  mes: 30,
} as const;

export default function VentasV2({ localActivo }: Props) {
  const { user } = useAuth();
  const [ventas, setVentas] = useState<Venta[]>([]);
  const [loading, setLoading] = useState(true);
  const [periodo, setPeriodo] = useState<keyof typeof PERIODOS>("mes");
  async function load() {
    setLoading(true);
    try {
      const days = PERIODOS[periodo];
      const since = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

      const q = db.from("ventas")
        .select("id, fecha, monto, medio_cobro, detalle, local_id")
        .gte("fecha", since)
        .order("fecha", { ascending: false });

      const res = await applyLocalScope(q, user, localActivo);
      setVentas((res.data ?? []) as Venta[]);
    } finally {
      setLoading(false);
    }
  }
useEffect(() => {
    if (!user?.tenant_id) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.tenant_id, localActivo, periodo]);


  const total = ventas.reduce((s, v) => s + Number(v.monto ?? 0), 0);
  const promedio = ventas.length > 0 ? total / ventas.length : 0;

  const porMedio = useMemo(() => {
    const m = new Map<string, number>();
    ventas.forEach(v => {
      m.set(v.medio_cobro, (m.get(v.medio_cobro) ?? 0) + Number(v.monto ?? 0));
    });
    return Array.from(m.entries()).map(([k, v]) => ({ medio: k, total: v })).sort((a, b) => b.total - a.total);
  }, [ventas]);

  if (loading) {
    return <div style={{ color: "var(--v2-text-muted)" }}>Cargando…</div>;
  }

  return (
    <div>
      <PageHeader
        eyebrow="Operación / Ventas"
        title="Ventas"
        sub={`${ventas.length} ventas en el período · Total $${formatMoney(total)}`}
        actions={
          <>
            <Select value={periodo} onChange={e => setPeriodo(e.target.value as keyof typeof PERIODOS)}>
              <option value="hoy">Hoy</option>
              <option value="semana">Últimos 7 días</option>
              <option value="mes">Últimos 30 días</option>
            </Select>
            <Button variant="primary" size="md" icon={<Plus size={14} />}>
              Cargar venta
            </Button>
          </>
        }
      />

      {/* === KPIs === */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "var(--v2-space-3)",
        marginBottom: "var(--v2-space-6)",
      }}>
        <StatCard
          hero
          icon={<DollarSign size={14} />}
          label="Total facturado"
          value={`$${formatMoney(total)}`}
          sub={`${ventas.length} ventas`}
        />
        <StatCard
          icon={<TrendingUp size={14} />}
          label="Ticket promedio"
          value={`$${formatMoney(promedio)}`}
        />
        <StatCard
          icon={<ShoppingBag size={14} />}
          label="Cantidad ventas"
          value={ventas.length}
        />
      </div>

      {/* === RANKING MEDIOS COBRO === */}
      <div className="v2-surface" style={{ marginBottom: "var(--v2-space-4)" }}>
        <div style={{
          padding: "var(--v2-space-4) var(--v2-space-5)",
          borderBottom: "1px solid var(--v2-border)",
        }}>
          <h2 className="v2-h2">Por medio de cobro</h2>
        </div>
        <div style={{
          padding: "var(--v2-space-3) var(--v2-space-5)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--v2-space-2)",
        }}>
          {porMedio.length === 0 ? (
            <div style={{ color: "var(--v2-text-muted)", textAlign: "center", padding: "var(--v2-space-6)" }}>
              Sin datos.
            </div>
          ) : porMedio.map(m => {
            const pct = total > 0 ? (m.total / total) * 100 : 0;
            return (
              <div key={m.medio} style={{
                display: "grid",
                gridTemplateColumns: "180px 1fr auto",
                gap: "var(--v2-space-3)",
                alignItems: "center",
                padding: "var(--v2-space-2) 0",
              }}>
                <div style={{ fontSize: "var(--v2-fs-sm)", fontWeight: 500 }}>{m.medio}</div>
                <div style={{
                  height: 8,
                  background: "var(--v2-bg-3)",
                  borderRadius: "var(--v2-radius-pill)",
                  overflow: "hidden",
                }}>
                  <div style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: "var(--v2-celeste)",
                    transition: "width var(--v2-tr-base)",
                  }}/>
                </div>
                <div style={{
                  fontSize: "var(--v2-fs-sm)",
                  textAlign: "right",
                  minWidth: 160,
                  fontFamily: "var(--v2-font-mono)",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  <span style={{ color: "var(--v2-text-strong)", fontWeight: 600 }}>
                    ${formatMoney(m.total)}
                  </span>
                  <span style={{ color: "var(--v2-text-subtle)", marginLeft: 8 }}>
                    {pct.toFixed(1)}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* === LISTADO === */}
      <div className="v2-surface">
        <div style={{
          padding: "var(--v2-space-4) var(--v2-space-5)",
          borderBottom: "1px solid var(--v2-border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
          <h2 className="v2-h2">Ventas del período</h2>
          <Button variant="ghost" size="sm" icon={<Filter size={14} />}>Filtros</Button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Fecha</th>
              <th style={th}>Medio cobro</th>
              <th style={th}>Detalle</th>
              <th style={{ ...th, textAlign: "right" }}>Monto</th>
            </tr>
          </thead>
          <tbody>
            {ventas.length === 0 ? (
              <tr><td colSpan={4} style={{ ...td, textAlign: "center", color: "var(--v2-text-muted)", padding: "var(--v2-space-8)" }}>
                Sin ventas en el período.
              </td></tr>
            ) : ventas.slice(0, 50).map(v => (
              <tr key={v.id} style={{ borderTop: "1px solid var(--v2-border)" }}>
                <td style={td}><span className="v2-mono">{fmtDate(v.fecha)}</span></td>
                <td style={td}><Badge variant="info">{v.medio_cobro}</Badge></td>
                <td style={td}>{v.detalle ?? "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>
                  <span className="v2-mono" style={{ color: "var(--v2-text-strong)", fontWeight: 600 }}>
                    ${formatMoney(v.monto)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {ventas.length > 50 && (
          <div style={{
            padding: "var(--v2-space-3) var(--v2-space-5)",
            borderTop: "1px solid var(--v2-border)",
            fontSize: "var(--v2-fs-xs)",
            color: "var(--v2-text-muted)",
            textAlign: "center",
          }}>
            Mostrando 50 de {ventas.length} · Usá filtros para ver el resto
          </div>
        )}
      </div>
    </div>
  );
}

function formatMoney(n: number) {
  return new Intl.NumberFormat("es-AR").format(Math.round(n ?? 0));
}

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

const th = {
  textAlign: "left" as const,
  padding: "var(--v2-space-3) var(--v2-space-4)",
  fontSize: "var(--v2-fs-xs)",
  fontWeight: 700 as const,
  letterSpacing: "var(--v2-tracking-wider)",
  textTransform: "uppercase" as const,
  color: "var(--v2-text-subtle)",
  background: "var(--v2-bg-3)",
  borderBottom: "1px solid var(--v2-border)",
};

const td = {
  padding: "var(--v2-space-3) var(--v2-space-4)",
  fontSize: "var(--v2-fs-sm)",
  color: "var(--v2-text)",
};
