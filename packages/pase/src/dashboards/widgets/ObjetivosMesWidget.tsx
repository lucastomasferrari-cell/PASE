import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { db } from "../../lib/supabase";
import { formatCurrency } from "../../lib/format";
import { EmptyState, TargetIcon } from "../../components/ui";
import type { WidgetContext } from "../types";
import { now, todayAR_ISO, toLocalISO } from '@pase/shared/utils';

interface ObjetivoMes {
  facturacion_objetivo: number | null;
  facturacion_actual: number;
  diaActual: number;
  diasDelMes: number;
}

// Objetivo de facturación del mes vigente vs facturado a la fecha.
// Lee tabla objetivos_mes (creada 2026-05-16). Si no hay objetivo seteado,
// invita al dueño a configurarlo desde /objetivos.
export function ObjetivosMesWidget({ ctx }: { ctx: WidgetContext }) {
  const [data, setData] = useState<ObjetivoMes | null>(null);
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

      // 1. Objetivo (de tabla objetivos_mes). Si hay local activo → ese local;
      //    si no, sumamos los objetivos de TODOS los locales con objetivo cargado.
      let qObj = db
        .from("objetivos_mes")
        .select("facturacion_objetivo, local_id")
        .eq("mes", primerDiaMes);
      if (ctx.localActivo !== null) qObj = qObj.eq("local_id", ctx.localActivo);
      const { data: objRows, error: objErr } = await qObj;
      if (cancelled) return;
      let facturacion_objetivo: number | null = null;
      // Capturamos los locales que SÍ tienen objetivo cargado este mes —
      // las ventas se filtran a esos mismos locales para que la comparación
      // sea apples-to-apples. Bug fix Lucas 2026-05-17: antes se cruzaba el
      // objetivo de Villa Crespo ($80M) con ventas consolidadas de todos los
      // locales ($197M) y daba 247% engañoso.
      const localesConObjetivo: number[] = [];
      if (!objErr && objRows && objRows.length > 0) {
        const suma = objRows.reduce((s, r) => {
          const row = r as { facturacion_objetivo: number | null; local_id: number | null };
          if (row.local_id != null) localesConObjetivo.push(row.local_id);
          return s + Number(row.facturacion_objetivo ?? 0);
        }, 0);
        if (suma > 0) facturacion_objetivo = suma;
      }

      // 2. Facturado a la fecha — SOLO de los locales con objetivo cargado
      //    (cuando estamos en modo consolidado). Si hay local activo, ya
      //    filtramos por ese.
      let qVen = db
        .from("ventas")
        .select("monto")
        .gte("fecha", primerDiaMes)
        .lte("fecha", hastaIso);
      if (ctx.localActivo !== null) {
        qVen = qVen.eq("local_id", ctx.localActivo);
      } else if (localesConObjetivo.length > 0) {
        qVen = qVen.in("local_id", localesConObjetivo);
      }
      const { data: venRows, error: venErr } = await qVen;
      if (cancelled || venErr) { setLoading(false); return; }
      const facturacion_actual = (venRows ?? []).reduce((s, r) => s + Number((r as { monto: number }).monto ?? 0), 0);

      setData({
        facturacion_objetivo,
        facturacion_actual,
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

  if (!data || data.facturacion_objetivo === null) {
    return (
      <EmptyState
        icon={<TargetIcon size={32} tone="muted" />}
        title="Sin objetivo cargado"
        description="Definí el objetivo de facturación del mes en Objetivos."
        size="compact"
        cta={<Link to="/objetivos" style={{ color: "var(--pase-celeste)", fontSize: "var(--pase-fs-sm)", textDecoration: "none" }}>Configurar →</Link>}
      />
    );
  }

  const pctAvance = (data.facturacion_actual / data.facturacion_objetivo) * 100;
  const pctTiempo = (data.diaActual / data.diasDelMes) * 100;
  const enRitmo = pctAvance >= pctTiempo - 5;
  const colorAvance = enRitmo ? "var(--pase-celeste)" : "#D97706";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>
          Facturado · {Math.round(pctAvance)}%
        </span>
        <span style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
          día {data.diaActual} de {data.diasDelMes}
        </span>
      </div>
      <div style={{
        fontSize: "var(--pase-fs-2xl)",
        fontWeight: 500,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "var(--pase-ls-tight)",
        color: "var(--pase-text)",
        lineHeight: 1.1,
      }}>
        {formatCurrency(data.facturacion_actual)}
      </div>
      <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", marginTop: 4 }}>
        de {formatCurrency(data.facturacion_objetivo)}
      </div>

      {/* Barra de progreso con marcador de "donde deberías estar" */}
      <div style={{ position: "relative", width: "100%", height: 8, background: "var(--pase-bg-soft)", borderRadius: 4, marginTop: 12, overflow: "hidden" }}>
        <div style={{
          width: `${Math.min(100, pctAvance)}%`,
          height: "100%",
          background: colorAvance,
          transition: "width 0.3s ease",
          borderRadius: 4,
        }} />
        {/* Marcador vertical del % del mes transcurrido */}
        <div style={{
          position: "absolute",
          top: -2,
          left: `${Math.min(100, pctTiempo)}%`,
          width: 2,
          height: 12,
          background: "var(--pase-text)",
          opacity: 0.5,
        }} />
      </div>
      <div style={{ fontSize: "var(--pase-fs-xs)", color: enRitmo ? "var(--pase-gold, #B8860B)" : "#D97706", marginTop: 8, display: "flex", alignItems: "center", gap: 4 }}>
        {enRitmo ? (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            En ritmo
          </>
        ) : "⚠ Atrasado vs ritmo del mes"}
      </div>
    </div>
  );
}
