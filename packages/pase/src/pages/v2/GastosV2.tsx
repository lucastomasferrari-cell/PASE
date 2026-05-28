// PASE V2 — Gastos
//
// Listado de gastos + KPIs + agrupado por categoría.
// Acción "Cargar gasto" → modal con form rápido.

import { useEffect, useState, useMemo } from "react";
import { db } from "../../lib/supabase";
import { useAuth, applyLocalScope } from "../../lib/auth";
import { Plus, Receipt, Filter } from "lucide-react";
import { Button } from "../../components/v2/Button";
import { Badge } from "../../components/v2/Badge";
import { StatCard } from "../../components/v2/StatCard";
import { PageHeader } from "../../components/v2/PageHeader";
import { Select } from "../../components/v2/Select";

interface Gasto {
  id: number;
  fecha: string;
  importe: number;
  categoria: string | null;
  detalle: string | null;
  medio_pago: string | null;
  local_id: number;
}

interface Props {
  localActivo: number | null;
}

const PERIODOS = { hoy: 0, semana: 7, mes: 30, trimestre: 90 } as const;

export default function GastosV2({ localActivo }: Props) {
  const { user } = useAuth();
  const [gastos, setGastos] = useState<Gasto[]>([]);
  const [loading, setLoading] = useState(true);
  const [periodo, setPeriodo] = useState<keyof typeof PERIODOS>("mes");
  async function load() {
    setLoading(true);
    try {
      const days = PERIODOS[periodo];
      const since = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

      const q = db.from("gastos")
        .select("id, fecha, importe, categoria, detalle, medio_pago, local_id")
        .gte("fecha", since)
        .order("fecha", { ascending: false });

      const res = await applyLocalScope(q, user, localActivo);
      setGastos((res.data ?? []) as Gasto[]);
    } finally {
      setLoading(false);
    }
  }
useEffect(() => {
    if (!user?.tenant_id) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.tenant_id, localActivo, periodo]);


  const total = gastos.reduce((s, g) => s + Number(g.importe ?? 0), 0);
  const porCategoria = useMemo(() => {
    const m = new Map<string, number>();
    gastos.forEach(g => {
      const cat = g.categoria ?? "Sin categoría";
      m.set(cat, (m.get(cat) ?? 0) + Number(g.importe ?? 0));
    });
    return Array.from(m.entries()).map(([k, v]) => ({ cat: k, total: v })).sort((a, b) => b.total - a.total);
  }, [gastos]);

  if (loading) {
    return <div style={{ color: "var(--v2-text-muted)" }}>Cargando…</div>;
  }

  return (
    <div>
      <PageHeader
        eyebrow="Operación / Gastos"
        title="Gastos"
        sub={`${gastos.length} gastos · Total $${formatMoney(total)}`}
        actions={
          <>
            <Select value={periodo} onChange={e => setPeriodo(e.target.value as keyof typeof PERIODOS)}>
              <option value="hoy">Hoy</option>
              <option value="semana">Últimos 7 días</option>
              <option value="mes">Últimos 30 días</option>
              <option value="trimestre">Últimos 90 días</option>
            </Select>
            <Button variant="primary" size="md" icon={<Plus size={14} />}>
              Cargar gasto
            </Button>
          </>
        }
      />

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "var(--v2-space-3)",
        marginBottom: "var(--v2-space-6)",
      }}>
        <StatCard hero icon={<Receipt size={14} />} label="Total gastos" value={`$${formatMoney(total)}`} sub={`${gastos.length} cargados`} />
        <StatCard icon={<Receipt size={14} />} label="Categorías distintas" value={porCategoria.length} />
        <StatCard icon={<Receipt size={14} />} label="Promedio por gasto" value={gastos.length ? `$${formatMoney(total / gastos.length)}` : "—"} />
      </div>

      <div className="v2-surface" style={{ marginBottom: "var(--v2-space-4)" }}>
        <div style={{ padding: "var(--v2-space-4) var(--v2-space-5)", borderBottom: "1px solid var(--v2-border)" }}>
          <h2 className="v2-h2">Por categoría</h2>
        </div>
        <div style={{ padding: "var(--v2-space-3) var(--v2-space-5)", display: "flex", flexDirection: "column", gap: "var(--v2-space-2)" }}>
          {porCategoria.length === 0 ? (
            <div style={{ color: "var(--v2-text-muted)", textAlign: "center", padding: "var(--v2-space-6)" }}>Sin datos.</div>
          ) : porCategoria.map(c => {
            const pct = total > 0 ? (c.total / total) * 100 : 0;
            return (
              <div key={c.cat} style={{
                display: "grid",
                gridTemplateColumns: "200px 1fr auto",
                gap: "var(--v2-space-3)",
                alignItems: "center",
                padding: "var(--v2-space-2) 0",
              }}>
                <div style={{ fontSize: "var(--v2-fs-sm)", fontWeight: 500 }}>{c.cat}</div>
                <div style={{ height: 8, background: "var(--v2-bg-3)", borderRadius: "var(--v2-radius-pill)", overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: "var(--v2-dorado)", transition: "width var(--v2-tr-base)" }}/>
                </div>
                <div style={{ fontSize: "var(--v2-fs-sm)", textAlign: "right", minWidth: 160, fontFamily: "var(--v2-font-mono)", fontVariantNumeric: "tabular-nums" }}>
                  <span style={{ color: "var(--v2-text-strong)", fontWeight: 600 }}>${formatMoney(c.total)}</span>
                  <span style={{ color: "var(--v2-text-subtle)", marginLeft: 8 }}>{pct.toFixed(1)}%</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="v2-surface">
        <div style={{ padding: "var(--v2-space-4) var(--v2-space-5)", borderBottom: "1px solid var(--v2-border)", display: "flex", justifyContent: "space-between" }}>
          <h2 className="v2-h2">Listado</h2>
          <Button variant="ghost" size="sm" icon={<Filter size={14} />}>Filtros</Button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Fecha</th>
              <th style={th}>Categoría</th>
              <th style={th}>Detalle</th>
              <th style={th}>Medio pago</th>
              <th style={{ ...th, textAlign: "right" }}>Importe</th>
            </tr>
          </thead>
          <tbody>
            {gastos.length === 0 ? (
              <tr><td colSpan={5} style={{ ...td, textAlign: "center", color: "var(--v2-text-muted)", padding: "var(--v2-space-8)" }}>
                Sin gastos en el período.
              </td></tr>
            ) : gastos.slice(0, 50).map(g => (
              <tr key={g.id} style={{ borderTop: "1px solid var(--v2-border)" }}>
                <td style={td}><span className="v2-mono">{fmtDate(g.fecha)}</span></td>
                <td style={td}>{g.categoria ? <Badge variant="info">{g.categoria}</Badge> : <Badge variant="neutro">Sin cat</Badge>}</td>
                <td style={td}>{g.detalle ?? "—"}</td>
                <td style={td}><span className="v2-text-subtle">{g.medio_pago ?? "—"}</span></td>
                <td style={{ ...td, textAlign: "right" }}>
                  <span className="v2-mono" style={{ color: "var(--v2-text-strong)", fontWeight: 600 }}>${formatMoney(g.importe)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatMoney(n: number) { return new Intl.NumberFormat("es-AR").format(Math.round(n ?? 0)); }
function fmtDate(s: string) { return new Date(s).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit" }); }

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
