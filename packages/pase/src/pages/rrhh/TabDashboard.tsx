import { fmt_$ } from "@pase/shared/utils";
import { MESES_SEL } from "./helpers";
import type { DashStats } from "./types";

interface TabDashboardProps {
  dashStats: DashStats | Record<string, never>;
  dashLoading: boolean;
}

export function TabDashboard({ dashStats, dashLoading }: TabDashboardProps) {
  if (dashLoading) return <div className="loading">Cargando...</div>;
  const d = dashStats;
  return (
    <>
      {/* Refactor 23-may: kpi-sm + kpi-value-compact globales. Antes
          padding:14×16 con kpi-value fontSize 22+ era overkill para 1 número
          chico + 2 líneas de sub. Ahora padding:10×12 + fontSize 18 (clase
          global kpi-value-compact). */}
      <div className="grid2" style={{marginBottom:12}}>
        {/* Próximo pago */}
        <div className="kpi kpi-sm">
          <div className="kpi-label">Próximo pago de sueldos</div>
          <div className="kpi-value-compact kpi-acc">{d.diasFinMes} días</div>
          <div className="kpi-sub" style={{marginTop:6}}>Estimado: <strong style={{color:"var(--acc)"}}>{fmt_$(d.estimado)}</strong></div>
          <div className="kpi-sub">{d.total} empleados activos</div>
        </div>
        {/* SAC */}
        <div className="kpi kpi-sm">
          <div className="kpi-label">Próximo SAC</div>
          <div className="kpi-value-compact" style={{color:"var(--warn)"}}>{d.diasSAC} días</div>
          <div className="kpi-sub" style={{marginTop:6}}>Fecha: {d.proxSAC} · Acumulado: <strong style={{color:"var(--warn)"}}>{fmt_$(d.totalSAC)}</strong></div>
          <div className="kpi-sub" style={{color:"var(--muted)",fontSize:9}}>SAC = mejor sueldo del semestre / 2 · Pago junio y diciembre</div>
        </div>
      </div>
      <div className="grid2">
        {/* Nómina */}
        <div className="kpi kpi-sm">
          <div className="kpi-label">Nómina</div>
          <div className="kpi-value-compact">{d.total}</div>
          <div className="kpi-sub">empleados activos</div>
          {d.sinDatos > 0 && <div className="kpi-sub" style={{color:"var(--warn)",marginTop:4}}>⚠ {d.sinDatos} con datos incompletos</div>}
        </div>
        {/* Estado del mes */}
        <div className="kpi kpi-sm">
          <div className="kpi-label">Estado — {MESES_SEL[(d.mes || 1) - 1]} {d.anio}</div>
          <div style={{display:"flex",gap:16,marginTop:8,fontSize:12}}>
            <div>Novedades: <strong>{d.conNovedades}</strong>/{d.total}</div>
            <div>Confirmadas: <strong style={{color:"var(--acc)"}}>{d.confirmadas}</strong></div>
            <div>Pagados: <strong style={{color:"var(--success)"}}>{d.pagados}</strong></div>
          </div>
          <div style={{marginTop:10,height:6,background:"var(--s3)",borderRadius:3,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${d.total ? (d.pagados / d.total * 100) : 0}%`,background:"var(--success)",borderRadius:3,transition:"width 0.3s"}} />
          </div>
          <div className="kpi-sub" style={{marginTop:4}}>{d.total ? Math.round(d.pagados / d.total * 100) : 0}% completado</div>
        </div>
      </div>
    </>
  );
}
