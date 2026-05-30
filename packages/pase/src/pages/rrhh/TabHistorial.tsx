import { useState, useMemo } from "react";
import { fmt_d, fmt_$ } from "@pase/shared/utils";
import { Modal } from "../../components/ui";
import type { Local } from "../../types";
import type { HistRow } from "./types";
import { MESES_SEL } from "./helpers";

interface TabHistorialProps {
  histMes: number;
  setHistMes: React.Dispatch<React.SetStateAction<number>>;
  histAnio: number;
  setHistAnio: React.Dispatch<React.SetStateAction<number>>;
  histLocal: string | number;
  setHistLocal: React.Dispatch<React.SetStateAction<string | number>>;
  locsDisp: Local[];
  esEnc: boolean;
  histLoading: boolean;
  histData: HistRow[];
  histDetalle: HistRow | null;
  setHistDetalle: React.Dispatch<React.SetStateAction<HistRow | null>>;
}

export function TabHistorial({
  histMes, setHistMes, histAnio, setHistAnio, histLocal, setHistLocal,
  locsDisp, esEnc, histLoading, histData, histDetalle, setHistDetalle,
}: TabHistorialProps) {
  // Toggle Anto 30-may: cuando carga pagos atrasados ("ponerse al día"),
  // la fecha que ella eligió es la del pago real (vieja) pero la fila se
  // muestra con su fecha de carga (hoy). Este toggle permite ordenar por
  // fecha real del pago (default) o por fecha de carga (auditoría).
  const [ordenarPor, setOrdenarPor] = useState<"fecha_pago" | "fecha_carga">("fecha_pago");
  const histOrdenado = useMemo(() => {
    const arr = [...histData];
    if (ordenarPor === "fecha_pago") {
      arr.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
    } else {
      arr.sort((a, b) => (b.fecha_carga || "").localeCompare(a.fecha_carga || ""));
    }
    return arr;
  }, [histData, ordenarPor]);
  return (
    <>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        <select className="search" style={{width:100}} value={histMes} onChange={e => setHistMes(parseInt(e.target.value))}>
          {MESES_SEL.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
        </select>
        <input type="number" className="search" style={{width:70}} value={histAnio} onChange={e => setHistAnio(parseInt(e.target.value))} />
        <select className="search" style={{width:160}} value={String(histLocal || "")} onChange={e => setHistLocal(e.target.value)}>
          {!esEnc && <option value="">Todas las sucursales</option>}
          {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
        </select>
        <div style={{flex:1}} />
        <span style={{fontSize:11, color:"var(--muted2)"}}>Ordenar por:</span>
        <select
          className="search"
          style={{width:160, fontSize:11}}
          value={ordenarPor}
          onChange={e => setOrdenarPor(e.target.value as "fecha_pago" | "fecha_carga")}
          title="'Fecha del pago' usa la fecha que elegiste al cargar (la real). 'Fecha de carga' usa el momento en que se registró en el sistema."
        >
          <option value="fecha_pago">Fecha del pago</option>
          <option value="fecha_carga">Fecha de carga</option>
        </select>
      </div>
      {histLoading ? <div className="loading">Cargando...</div> : histData.length === 0 ? <div className="empty">Sin pagos en este período</div> : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>{ordenarPor === "fecha_pago" ? "Fecha pago" : "Fecha carga"}</th>
                <th>Empleado</th>
                <th>Puesto</th>
                <th>Tipo</th>
                <th style={{textAlign:"right"}}>Monto</th>
                <th></th>
              </tr>
            </thead>
            <tbody>{histOrdenado.map((h, i) => {
              const fechaPrincipal = ordenarPor === "fecha_pago" ? h.fecha : (h.fecha_carga?.split("T")[0] || h.fecha);
              const fechaSecundaria = ordenarPor === "fecha_pago" ? h.fecha_carga?.split("T")[0] : h.fecha;
              const distintas = fechaPrincipal && fechaSecundaria && fechaPrincipal !== fechaSecundaria;
              return (
                <tr key={i}>
                  <td className="mono" style={{fontSize:11}}>
                    {fmt_d(fechaPrincipal)}
                    {distintas && (
                      <div style={{fontSize:9, color:"var(--muted2)", marginTop:2}}>
                        {ordenarPor === "fecha_pago" ? "cargado " : "pago "}{fmt_d(fechaSecundaria)}
                      </div>
                    )}
                  </td>
                  <td style={{fontWeight:500,fontSize:12}}>{h.emp?.apellido}, {h.emp?.nombre}</td>
                  <td><span className="badge b-muted" style={{fontSize:8}}>{h.emp?.puesto}</span></td>
                  <td><span className="badge b-info" style={{fontSize:9}}>{h.label}</span></td>
                  <td style={{textAlign:"right"}}><span className="num kpi-success">{fmt_$(h.monto)}</span></td>
                  <td><button className="btn btn-ghost btn-sm" onClick={() => setHistDetalle(h)}>Ver</button></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}

      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido. */}
      <Modal
        isOpen={!!histDetalle}
        onClose={() => setHistDetalle(null)}
        title={histDetalle ? `${histDetalle.label} — ${histDetalle.emp?.apellido}, ${histDetalle.emp?.nombre}` : ""}
        maxWidth={520}
        footer={<button className="btn btn-sec" onClick={() => setHistDetalle(null)}>Cerrar</button>}
      >
        {histDetalle && (
          <>
            <div style={{marginBottom:12,fontSize:12,color:"var(--muted2)"}}>
              Fecha: {fmt_d(histDetalle.fecha)} · Total: <strong style={{color:"var(--acc)"}}>{fmt_$(histDetalle.monto)}</strong>
            </div>
            {histDetalle.nov && (
              <div style={{background:"var(--s2)",borderRadius:"var(--r)",padding:12}}>
                <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Novedades</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:16,fontSize:11}}>
                  {histDetalle.nov.inasistencias > 0 && <div>Inasistencias: <strong>{histDetalle.nov.inasistencias}</strong></div>}
                  <div>Presentismo: <strong>{histDetalle.nov.presentismo === "MANTIENE" ? "Tiene" : "No tiene"}</strong></div>
                  {histDetalle.nov.horas_extras > 0 && <div>HS extra: <strong>{histDetalle.nov.horas_extras}</strong></div>}
                  {histDetalle.nov.dobles > 0 && <div>Dobles: <strong>{histDetalle.nov.dobles}</strong></div>}
                  {histDetalle.nov.feriados > 0 && <div>Feriados: <strong>{histDetalle.nov.feriados}</strong></div>}
                  {histDetalle.nov.adelantos > 0 && <div>Adelantos: <strong>{fmt_$(histDetalle.nov.adelantos)}</strong></div>}
                  {histDetalle.nov.observaciones && <div>Obs: <strong>{histDetalle.nov.observaciones}</strong></div>}
                </div>
                {histDetalle.liq && (
                  <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid var(--bd)",display:"flex",flexWrap:"wrap",gap:16,fontSize:11}}>
                    <div>Base: <strong>{fmt_$(histDetalle.liq.sueldo_base)}</strong></div>
                    {histDetalle.liq.descuento_ausencias > 0 && <div style={{color:"var(--danger)"}}>-Ausencias: {fmt_$(histDetalle.liq.descuento_ausencias)}</div>}
                    {histDetalle.liq.total_horas_extras > 0 && <div>+HE: {fmt_$(histDetalle.liq.total_horas_extras)}</div>}
                    {histDetalle.liq.monto_presentismo > 0 && <div style={{color:"var(--success)"}}>+Present.: {fmt_$(histDetalle.liq.monto_presentismo)}</div>}
                    {histDetalle.liq.adelantos > 0 && <div style={{color:"var(--warn)"}}>-Adelantos: {fmt_$(histDetalle.liq.adelantos)}</div>}
                    <div><strong>Total: {fmt_$(histDetalle.liq.total_a_pagar)}</strong></div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
