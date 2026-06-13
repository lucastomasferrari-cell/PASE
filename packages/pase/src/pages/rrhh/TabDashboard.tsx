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
  const pctPagados = d.total ? Math.round(d.pagados / d.total * 100) : 0;
  return (
    <>
      <div className="grid2" style={{marginBottom:12}}>
        <div className="kpi kpi-sm">
          <div className="kpi-label">Próximo pago de sueldos</div>
          <div className="kpi-value-compact">{d.diasFinMes} días</div>
          <div className="kpi-sub" style={{marginTop:6}}>Estimado: <strong>{fmt_$(d.estimado)}</strong></div>
          <div className="kpi-sub">{d.total} empleados activos</div>
        </div>
        <div className="kpi kpi-sm">
          <div className="kpi-label">Próximo SAC</div>
          <div className="kpi-value-compact">{d.diasSAC} días</div>
          <div className="kpi-sub" style={{marginTop:6}}>Fecha: {d.proxSAC} · Acumulado: <strong>{fmt_$(d.totalSAC)}</strong></div>
          <div className="kpi-sub" style={{fontSize:10,marginTop:2}}>SAC = mejor sueldo del semestre / 2 · Pago junio y diciembre</div>
        </div>
      </div>
      <div className="grid2">
        <div className="kpi kpi-sm">
          <div className="kpi-label">Nómina</div>
          <div className="kpi-value-compact">{d.total}</div>
          <div className="kpi-sub">empleados activos</div>
          {d.sinDatos > 0 && <div className="kpi-sub" style={{marginTop:4}}>⚠ {d.sinDatos} con datos incompletos</div>}
        </div>
        <div className="kpi kpi-sm">
          <div className="kpi-label">Estado — {MESES_SEL[(d.mes || 1) - 1]} {d.anio}</div>
          <div style={{display:"flex",gap:16,marginTop:8,fontSize:12,color:"var(--pase-text)"}}>
            <div>Novedades: <strong>{d.conNovedades}</strong>/{d.total}</div>
            <div>Confirmadas: <strong>{d.confirmadas}</strong></div>
            <div>Pagados: <strong>{d.pagados}</strong></div>
          </div>
          <div style={{marginTop:10,height:6,background:"var(--pase-border)",borderRadius:3,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${pctPagados}%`,background:"var(--pase-celeste)",borderRadius:3,transition:"width 0.3s"}} />
          </div>
          <div className="kpi-sub" style={{marginTop:4}}>{pctPagados}% completado</div>
        </div>
      </div>
    </>
  );
}
