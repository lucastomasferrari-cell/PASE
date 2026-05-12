import { fmt_$ } from "../../lib/utils";
import type { Local } from "../../types";
import type { Empleado } from "../../types/rrhh";
import type { NovedadEditable } from "./types";
import { MESES_SEL, PRESENTISMO_OPTS, calcularValorDoble, calcLiquidacion, inp } from "./helpers";

interface TabNovedadesProps {
  novMes: number;
  setNovMes: React.Dispatch<React.SetStateAction<number>>;
  novAnio: number;
  setNovAnio: React.Dispatch<React.SetStateAction<number>>;
  novLocal: string | number;
  setNovLocal: (v: string) => void;
  locsDisp: Local[];
  novLoading: boolean;
  novEmps: Empleado[];
  novMap: Record<string, NovedadEditable>;
  updateNov: (empId: string, field: keyof NovedadEditable, value: string | number) => void;
  confirmarUno: (emp: Empleado) => Promise<void>;
  confirmarTodas: () => Promise<void>;
  editarNov: (empId: string) => Promise<void>;
  esDueno: boolean;
}

export function TabNovedades({
  novMes, setNovMes, novAnio, setNovAnio, novLocal, setNovLocal,
  locsDisp, novLoading, novEmps, novMap,
  updateNov, confirmarUno, confirmarTodas, editarNov, esDueno,
}: TabNovedadesProps) {
  const pendientesCount = novEmps.filter(e => (novMap[e.id]?.estado ?? "borrador") !== "confirmado").length;
  return (
    <>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        <select className="search" style={{width:100}} value={novMes} onChange={e => setNovMes(parseInt(e.target.value))}>
          {MESES_SEL.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
        </select>
        <input type="number" className="search" style={{width:70}} value={novAnio} onChange={e => setNovAnio(parseInt(e.target.value))} />
        <select className="search" style={{width:160}} value={String(novLocal || "")} onChange={e => setNovLocal(e.target.value)}>
          <option value="">Seleccionar local...</option>
          {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
        </select>
        <div style={{flex:1}} />
        {esDueno && novLocal && novEmps.length > 0 && pendientesCount > 0 && (
          <button className="btn btn-acc btn-sm" onClick={confirmarTodas}>
            Confirmar todas ({pendientesCount}) → listo para pago
          </button>
        )}
      </div>

      {!novLocal ? <div className="alert alert-info">Seleccioná un local para cargar novedades</div> :
       novLoading ? <div className="loading">Cargando...</div> :
       novEmps.length === 0 ? <div className="empty">Sin empleados activos en este local</div> : (
        <div className="panel">
          <div style={{overflowX:"auto"}}>
          <table>
            <thead><tr>
              <th style={{minWidth:120,fontSize:8}}>Empleado</th><th style={{width:50,fontSize:8}}>Inasist.</th><th style={{width:90,fontSize:8}}>Present.</th>
              <th style={{width:50,fontSize:8}}>HS Ex.</th><th style={{width:50,fontSize:8}}>Dobles</th>
              <th style={{width:50,fontSize:8}}>Ferid.</th><th style={{width:65,fontSize:8}}>Adel.$</th>
              <th style={{width:90,fontSize:8}}>Obs.</th>
              <th style={{textAlign:"right",width:80,fontSize:8}}>Preview</th><th style={{width:80,fontSize:8}}>Acción</th>
            </tr></thead>
            <tbody>{novEmps.map(emp => {
              const nov = novMap[emp.id] || {};
              const locked = nov.estado === "confirmado";
              const vd = calcularValorDoble(emp);
              const preview = calcLiquidacion(emp, nov, vd).total_a_pagar;
              return (
                <tr key={emp.id}>
                  <td style={{fontWeight:500,fontSize:10}}>{emp.apellido}, {emp.nombre}</td>
                  <td><input type="number" style={{...inp,width:40}} disabled={locked} value={nov.inasistencias ?? 0} onChange={e => updateNov(emp.id, "inasistencias", parseFloat(e.target.value) || 0)} /></td>
                  <td><select style={{...inp,width:82,textAlign:"left"}} disabled={locked} value={nov.presentismo || "MANTIENE"} onChange={e => updateNov(emp.id, "presentismo", e.target.value)}>
                    {PRESENTISMO_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select></td>
                  <td><input type="number" style={{...inp,width:40}} disabled={locked} value={nov.horas_extras ?? 0} onChange={e => updateNov(emp.id, "horas_extras", parseFloat(e.target.value) || 0)} /></td>
                  <td><input type="number" style={{...inp,width:40}} disabled={locked} value={nov.dobles ?? 0} onChange={e => updateNov(emp.id, "dobles", parseFloat(e.target.value) || 0)} /></td>
                  <td><input type="number" style={{...inp,width:40}} disabled={locked} value={nov.feriados ?? 0} onChange={e => updateNov(emp.id, "feriados", parseFloat(e.target.value) || 0)} /></td>
                  <td><input type="number" style={{...inp,width:55}} disabled={locked} value={nov.adelantos ?? 0} onChange={e => updateNov(emp.id, "adelantos", parseFloat(e.target.value) || 0)} /></td>
                  <td><input style={{...inp,width:80,textAlign:"left"}} disabled={locked} value={nov.observaciones || ""} onChange={e => updateNov(emp.id, "observaciones", e.target.value)} /></td>
                  <td style={{textAlign:"right"}}><span className="num" style={{color: preview < 0 ? "var(--danger)" : "var(--success)",fontSize:11}}>{fmt_$(preview)}</span></td>
                  <td>
                    <div style={{display:"flex",gap:4}}>
                      {nov.estado === "confirmado" ? (
                        <>
                          <span className="badge b-success" style={{fontSize:7}}>OK</span>
                          {esDueno && <button className="btn btn-ghost btn-sm" style={{fontSize:9,padding:"2px 6px"}} onClick={() => editarNov(emp.id)}>Editar</button>}
                        </>
                      ) : (
                        <button className="btn btn-acc btn-sm" style={{fontSize:9,padding:"2px 8px"}} onClick={() => confirmarUno(emp)}>OK</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
          </div>
        </div>
      )}
    </>
  );
}
