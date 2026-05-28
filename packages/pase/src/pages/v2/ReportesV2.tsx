// PASE V2 — Reportes (EERR / P&L)
//
// Estado de Resultados base devengada (no percibida):
// - Lee ventas + facturas + gastos + rrhh_liquidaciones por fecha del hecho económico
// - NO lee saldos_caja (eso es percibido)
//
// Spec: docs/superpowers/specs/2026-05-28-caja-finanzas-pl-rediseno.md

import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { useAuth, applyLocalScope } from "../../lib/auth";
import { TrendingUp, TrendingDown, DollarSign, Calendar } from "lucide-react";
import { StatCard } from "../../components/v2/StatCard";
import { PageHeader } from "../../components/v2/PageHeader";
import { Select } from "../../components/v2/Select";

interface Props {
  localActivo: number | null;
}

export default function ReportesV2({ localActivo }: Props) {
  const { user } = useAuth();
  const now = new Date();
  const [mes, setMes] = useState(now.getMonth() + 1);
  const [anio, setAnio] = useState(now.getFullYear());
  const [ventas, setVentas] = useState(0);
  const [gastosPorCat, setGastosPorCat] = useState<{ cat: string; total: number }[]>([]);
  const [facturasMes, setFacturasMes] = useState(0);
  const [sueldosMes, setSueldosMes] = useState(0);
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try {
      const desde = `${anio}-${String(mes).padStart(2, "0")}-01`;
      const hasta = mes === 12
        ? `${anio + 1}-01-01`
        : `${anio}-${String(mes + 1).padStart(2, "0")}-01`;

      const vQ = db.from("ventas").select("monto").gte("fecha", desde).lt("fecha", hasta);
      const gQ = db.from("gastos").select("importe, categoria").gte("fecha", desde).lt("fecha", hasta);
      const fQ = db.from("facturas").select("total").gte("fecha", desde).lt("fecha", hasta);
      const lQ = db.from("rrhh_liquidaciones").select("importe_total").gte("periodo_desde", desde).lt("periodo_desde", hasta);

      const [vRes, gRes, fRes, lRes] = await Promise.all([
        applyLocalScope(vQ, user, localActivo),
        applyLocalScope(gQ, user, localActivo),
        applyLocalScope(fQ, user, localActivo),
        applyLocalScope(lQ, user, localActivo),
      ]);

      setVentas((vRes.data ?? []).reduce((s, v) => s + Number(v.monto ?? 0), 0));
      setFacturasMes((fRes.data ?? []).reduce((s, f) => s + Number(f.total ?? 0), 0));
      setSueldosMes((lRes.data ?? []).reduce((s, l) => s + Number(l.importe_total ?? 0), 0));

      const m = new Map<string, number>();
      (gRes.data ?? []).forEach((g: { importe: number; categoria: string | null }) => {
        const cat = g.categoria ?? "Sin categoría";
        m.set(cat, (m.get(cat) ?? 0) + Number(g.importe ?? 0));
      });
      setGastosPorCat(Array.from(m.entries()).map(([cat, total]) => ({ cat, total })).sort((a, b) => b.total - a.total));
    } finally {
      setLoading(false);
    }
  }
useEffect(() => {
    if (!user?.tenant_id) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.tenant_id, localActivo, mes, anio]);


  const gastosTotal = gastosPorCat.reduce((s, g) => s + g.total, 0);
  const cmv = facturasMes; // simplificación: facturas del mes ≈ CMV cargado
  const resultadoBruto = ventas - cmv;
  const resultadoNeto = resultadoBruto - gastosTotal - sueldosMes;
  const margenBruto = ventas > 0 ? (resultadoBruto / ventas) * 100 : 0;
  const margenNeto = ventas > 0 ? (resultadoNeto / ventas) * 100 : 0;

  if (loading) return <div style={{ color: "var(--v2-text-muted)" }}>Cargando…</div>;

  const meses = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

  return (
    <div>
      <PageHeader
        eyebrow="Dirección / Reportes"
        title="Estado de Resultados"
        sub={`${meses[mes - 1]} ${anio} · Base devengada`}
        actions={
          <>
            <Select value={mes} onChange={e => setMes(Number(e.target.value))}>
              {meses.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </Select>
            <Select value={anio} onChange={e => setAnio(Number(e.target.value))}>
              {[anio - 2, anio - 1, anio, anio + 1].map(y => <option key={y} value={y}>{y}</option>)}
            </Select>
          </>
        }
      />

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "var(--v2-space-3)",
        marginBottom: "var(--v2-space-6)",
      }}>
        <StatCard hero icon={<DollarSign size={14} />} label="Ventas" value={`$${formatMoney(ventas)}`} sub="Devengado en el mes" />
        <StatCard icon={<TrendingDown size={14} />} label="CMV (facturas)" value={`$${formatMoney(cmv)}`} sub="Compras del mes" />
        <StatCard
          icon={<TrendingUp size={14} />}
          label="Resultado bruto"
          value={`$${formatMoney(resultadoBruto)}`}
          sub={`Margen ${margenBruto.toFixed(1)}%`}
          trend={resultadoBruto >= 0 ? "up" : "down"}
        />
        <StatCard
          icon={<Calendar size={14} />}
          label="Resultado neto"
          value={`$${formatMoney(resultadoNeto)}`}
          sub={`Margen ${margenNeto.toFixed(1)}%`}
          status={resultadoNeto >= 0 ? "ok" : "error"}
          statusText={resultadoNeto >= 0 ? "Mes positivo" : "Pérdida"}
        />
      </div>

      <div className="v2-surface" style={{ marginBottom: "var(--v2-space-4)" }}>
        <div style={{ padding: "var(--v2-space-4) var(--v2-space-5)", borderBottom: "1px solid var(--v2-border)" }}>
          <h2 className="v2-h2">Desglose</h2>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <PnLRow label="Ventas" value={ventas} bold color="celeste" />
            <PnLRow label="(–) CMV" value={-cmv} />
            <PnLRow label="= Resultado bruto" value={resultadoBruto} bold pct={ventas > 0 ? (resultadoBruto / ventas) * 100 : null} />
            <PnLRow label="(–) Sueldos" value={-sueldosMes} />
            <PnLRow label="(–) Gastos operativos" value={-gastosTotal} />
            <PnLRow label="= Resultado neto" value={resultadoNeto} bold pct={ventas > 0 ? (resultadoNeto / ventas) * 100 : null} color={resultadoNeto >= 0 ? "celeste" : "rojo"} />
          </tbody>
        </table>
      </div>

      <div className="v2-surface">
        <div style={{ padding: "var(--v2-space-4) var(--v2-space-5)", borderBottom: "1px solid var(--v2-border)" }}>
          <h2 className="v2-h2">Gastos por categoría</h2>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Categoría</th>
              <th style={{ ...th, textAlign: "right" }}>Importe</th>
              <th style={{ ...th, textAlign: "right" }}>% de gastos</th>
            </tr>
          </thead>
          <tbody>
            {gastosPorCat.length === 0 ? (
              <tr><td colSpan={3} style={{ ...td, textAlign: "center", color: "var(--v2-text-muted)", padding: "var(--v2-space-8)" }}>Sin gastos en el período.</td></tr>
            ) : gastosPorCat.map(g => {
              const pct = gastosTotal > 0 ? (g.total / gastosTotal) * 100 : 0;
              return (
                <tr key={g.cat} style={{ borderTop: "1px solid var(--v2-border)" }}>
                  <td style={td}>{g.cat}</td>
                  <td style={{ ...td, textAlign: "right" }}><span className="v2-mono">${formatMoney(g.total)}</span></td>
                  <td style={{ ...td, textAlign: "right" }}><span className="v2-mono v2-text-subtle">{pct.toFixed(1)}%</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PnLRow({ label, value, bold, pct, color }: { label: string; value: number; bold?: boolean; pct?: number | null; color?: "celeste" | "rojo" | "default" }) {
  const colorStyle = color === "celeste" ? "var(--v2-celeste)"
                   : color === "rojo" ? "var(--v2-rojo)"
                   : "var(--v2-text-strong)";
  return (
    <tr style={{ borderTop: "1px solid var(--v2-border)" }}>
      <td style={{
        padding: "var(--v2-space-3) var(--v2-space-5)",
        fontSize: "var(--v2-fs-sm)",
        fontWeight: bold ? 700 : 500,
        color: bold ? "var(--v2-text-strong)" : "var(--v2-text)",
      }}>
        {label}
      </td>
      <td style={{
        padding: "var(--v2-space-3) var(--v2-space-5)",
        textAlign: "right",
      }}>
        <span className="v2-mono" style={{
          fontWeight: bold ? 700 : 500,
          color: bold ? colorStyle : "var(--v2-text)",
        }}>
          {value >= 0 ? "+" : "−"}${formatMoney(Math.abs(value))}
        </span>
      </td>
      <td style={{
        padding: "var(--v2-space-3) var(--v2-space-5)",
        textAlign: "right",
        width: 120,
      }}>
        {pct != null && (
          <span className="v2-mono v2-text-subtle">{pct.toFixed(1)}%</span>
        )}
      </td>
    </tr>
  );
}

function formatMoney(n: number) { return new Intl.NumberFormat("es-AR").format(Math.round(n ?? 0)); }

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
