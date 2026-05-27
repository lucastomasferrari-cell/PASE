import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
import { EmptyState, ScaleIcon } from "../../components/ui";
import type { WidgetContext } from "../types";
import { now, todayAR_ISO, toLocalISO } from '../../lib/utils';

interface BepData {
  costos_fijos_mes: number;
  /** Sueldos liquidados/pagados el mes anterior — referencia confiable de labor cost. */
  labor_cost_mes_anterior: number;
  /** Suma efectiva: costos_fijos_mes + labor_cost_mes_anterior. */
  total_fijos: number;
  margen_pct: number;
  facturacion_actual: number;
  bep: number;
  diaActual: number;
  diasDelMes: number;
}

// Punto de Equilibrio del mes: cuánto hay que facturar para cubrir TODO
// el costo fijo del mes (fijos cargados + labor cost real del mes anterior)
// dado el margen de contribución esperado. Compara con facturación a la fecha.
//
// Decisión Lucas 2026-05-17: el cálculo de BEP usa
//   BEP = (costos_fijos_cargados + labor_cost_mes_anterior) / margen %
// porque los sueldos son un fijo concreto que se conoce con precisión del
// mes anterior — no hace falta esperar a fin de mes. Sumarlos al campo
// libre "costos fijos" (que típicamente solo tiene alquiler + servicios)
// da un BEP más realista.
//
// A mitad de mes los EERR mienten (fijos caen los primeros 15 días). El BEP
// es métrica honesta para cualquier momento del mes.
export function PuntoEquilibrioWidget({ ctx }: { ctx: WidgetContext }) {
  const [data, setData] = useState<BepData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function reload() {
      setLoading(true);
      const today = now();
      const year = today.getFullYear();
      const month = today.getMonth();
      const primerDiaMes = toLocalISO(new Date(year, month, 1));
      const ultimoDiaMes = new Date(year, month + 1, 0).getDate();
      const diaActual = today.getDate();
      const hastaIso = todayAR_ISO();

      // 1. Objetivos del mes (costos_fijos + margen)
      let qObj = db
        .from("objetivos_mes")
        .select("costos_fijos_mes, margen_contribucion_pct, local_id")
        .eq("mes", primerDiaMes);
      if (ctx.localActivo !== null) qObj = qObj.eq("local_id", ctx.localActivo);
      const { data: objRows, error: objErr } = await qObj;
      if (cancelled) return;
      if (objErr || !objRows || objRows.length === 0) {
        setData(null);
        setLoading(false);
        return;
      }
      // Capturamos los locales con BEP cargado — las ventas se filtran a esos
      // mismos locales para comparar apples-to-apples (bug fix Lucas 2026-05-17).
      const localesConBep: number[] = [];
      const costos_fijos_mes = objRows.reduce((s, r) => {
        const row = r as { costos_fijos_mes: number | null; margen_contribucion_pct: number | null; local_id: number | null };
        if (row.local_id != null && Number(row.costos_fijos_mes ?? 0) > 0) {
          localesConBep.push(row.local_id);
        }
        return s + Number(row.costos_fijos_mes ?? 0);
      }, 0);
      // Margen: promedio de los locales (asume similar entre sucursales).
      const margenes = objRows
        .map(r => Number((r as { margen_contribucion_pct: number | null }).margen_contribucion_pct ?? 0))
        .filter(m => m > 0);
      const margen_pct = margenes.length > 0
        ? margenes.reduce((a, b) => a + b, 0) / margenes.length
        : 50;

      if (costos_fijos_mes <= 0) {
        setData(null);
        setLoading(false);
        return;
      }

      // 2. Labor cost del MES ANTERIOR (sueldos liquidados+pagados). Es la
      //    referencia más confiable del costo de personal del mes en curso
      //    porque los sueldos varían poco mes a mes. Decisión Lucas 2026-05-17.
      const primerDiaMesAnt = toLocalISO(new Date(year, month - 1, 1));
      const ultimoDiaMesAnt = toLocalISO(new Date(year, month, 0));
      const qLabor = db
        .from("rrhh_liquidaciones")
        .select("total_a_pagar, rrhh_novedades!inner(rrhh_empleados!inner(local_id))")
        .eq("estado", "pagado")
        .eq("anulado", false)
        .gte("calculado_at", primerDiaMesAnt + "T00:00:00")
        .lte("calculado_at", ultimoDiaMesAnt + "T23:59:59");
      const { data: laborRows, error: laborErr } = await qLabor;
      if (cancelled) return;
      let labor_cost_mes_anterior = 0;
      if (!laborErr && laborRows) {
        for (const row of laborRows) {
          const r = row as unknown as {
            total_a_pagar: number;
            rrhh_novedades: { rrhh_empleados: { local_id: number } } | null;
          };
          const localId = r.rrhh_novedades?.rrhh_empleados?.local_id;
          // Filtramos por mismo scope que el BEP: si hay localActivo, ese.
          // Si no, los locales que tienen BEP cargado.
          if (ctx.localActivo !== null && localId !== ctx.localActivo) continue;
          if (ctx.localActivo === null && localId != null && !localesConBep.includes(localId)) continue;
          labor_cost_mes_anterior += Number(r.total_a_pagar ?? 0);
        }
      }

      const total_fijos = costos_fijos_mes + labor_cost_mes_anterior;

      // 3. Facturación a la fecha — SOLO de los locales que tienen BEP cargado
      //    (cuando estamos en modo consolidado).
      let qVen = db
        .from("ventas")
        .select("monto")
        .gte("fecha", primerDiaMes)
        .lte("fecha", hastaIso);
      if (ctx.localActivo !== null) {
        qVen = qVen.eq("local_id", ctx.localActivo);
      } else if (localesConBep.length > 0) {
        qVen = qVen.in("local_id", localesConBep);
      }
      const { data: venRows, error: venErr } = await qVen;
      if (cancelled || venErr) { setLoading(false); return; }
      const facturacion_actual = (venRows ?? []).reduce(
        (s, r) => s + Number((r as { monto: number }).monto ?? 0),
        0,
      );

      const bep = total_fijos / (margen_pct / 100);

      setData({
        costos_fijos_mes,
        labor_cost_mes_anterior,
        total_fijos,
        margen_pct,
        facturacion_actual,
        bep,
        diaActual,
        diasDelMes: ultimoDiaMes,
      });
      setLoading(false);
    }
    void reload();
    return () => { cancelled = true; };
  }, [ctx.localActivo]);

  if (loading) {
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  if (!data) {
    return (
      <EmptyState
        icon={<ScaleIcon size={32} tone="muted" />}
        title="Sin datos para calcular BEP"
        description="Cargá costos fijos y margen esperado del mes en Objetivos."
        size="compact"
        cta={<Link to="/objetivos" style={{ color: "var(--pase-celeste)", fontSize: "var(--pase-fs-sm)", textDecoration: "none" }}>Configurar →</Link>}
      />
    );
  }

  const pctBep = (data.facturacion_actual / data.bep) * 100;
  const enZonaGanancia = data.facturacion_actual >= data.bep;
  const faltante = Math.max(0, data.bep - data.facturacion_actual);
  const diasRestantes = data.diasDelMes - data.diaActual;
  const ventaDiariaNec = diasRestantes > 0 ? faltante / diasRestantes : faltante;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>
          Punto de equilibrio
        </span>
        <span style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
          margen {data.margen_pct.toFixed(0)}%
        </span>
      </div>
      <div style={{
        fontSize: "var(--pase-fs-2xl)",
        fontWeight: 500,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "var(--pase-ls-tight)",
        color: enZonaGanancia ? "var(--pase-celeste)" : "var(--pase-text)",
        lineHeight: 1.1,
      }}>
        {Math.round(pctBep)}%
      </div>
      <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", marginTop: 4 }}>
        {formatCurrency(data.facturacion_actual)} de {formatCurrency(data.bep)}
      </div>

      <div style={{ width: "100%", height: 8, background: "var(--pase-bg-soft)", borderRadius: 4, marginTop: 12, overflow: "hidden" }}>
        <div style={{
          width: `${Math.min(100, pctBep)}%`,
          height: "100%",
          background: enZonaGanancia ? "var(--pase-celeste)" : "#D97706",
          transition: "width 0.3s ease",
          borderRadius: 4,
        }} />
      </div>

      {/* Desglose del cálculo — para que se entienda de dónde sale el BEP. */}
      <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginTop: 8, lineHeight: 1.5 }}>
        Fijos cargados: <span style={{ color: "var(--pase-text)", fontVariantNumeric: "tabular-nums" }}>{formatCurrency(data.costos_fijos_mes)}</span>
        {data.labor_cost_mes_anterior > 0 && (
          <> · Labor cost (mes ant.): <span style={{ color: "var(--pase-text)", fontVariantNumeric: "tabular-nums" }}>{formatCurrency(data.labor_cost_mes_anterior)}</span></>
        )}
      </div>

      {enZonaGanancia ? (
        <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-gold, #B8860B)", marginTop: 10, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          Cubriste los fijos. Cada peso vendido suma a la ganancia.
        </div>
      ) : (
        <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", marginTop: 10, lineHeight: 1.5 }}>
          Faltan <strong style={{ color: "var(--pase-text)" }}>{formatCurrency(faltante)}</strong> en{" "}
          {diasRestantes} {diasRestantes === 1 ? "día" : "días"} · ritmo{" "}
          <strong style={{ color: "var(--pase-text)" }}>{formatCurrency(ventaDiariaNec)}</strong>/día
        </div>
      )}
    </div>
  );
}
