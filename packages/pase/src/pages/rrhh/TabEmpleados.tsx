import { fmt_$ } from "../../lib/utils";
import { calcularVacaciones } from "../../lib/calculos/rrhh";
import type { Local } from "../../types";
import type { Empleado } from "../../types/rrhh";
import type { EmpForm, EmpModalState } from "./types";

interface TabEmpleadosProps {
  empFiltLocal: string | number;
  setEmpFiltLocal: React.Dispatch<React.SetStateAction<string | number>>;
  empSearch: string;
  setEmpSearch: React.Dispatch<React.SetStateAction<string>>;
  empMostrarInactivos: boolean;
  setEmpMostrarInactivos: React.Dispatch<React.SetStateAction<boolean>>;
  esEnc: boolean;
  locsDisp: Local[];
  locales: Local[];
  empsFilt: Empleado[];
  vacTomadas: Record<string, number>;
  puestos: string[];
  empModal: EmpModalState;
  setEmpModal: React.Dispatch<React.SetStateAction<EmpModalState>>;
  empForm: EmpForm;
  setEmpForm: React.Dispatch<React.SetStateAction<EmpForm>>;
  abrirEmpNuevo: () => void;
  abrirEmpEditar: (e: Empleado) => void;
  guardarEmp: () => Promise<void>;
  setLegajoId: React.Dispatch<React.SetStateAction<string | null>>;
  puedeVerInactivos: boolean;
}

export function TabEmpleados({
  empFiltLocal, setEmpFiltLocal, empSearch, setEmpSearch,
  empMostrarInactivos, setEmpMostrarInactivos,
  esEnc, locsDisp, locales, empsFilt, vacTomadas, puestos,
  empModal, setEmpModal, empForm, setEmpForm,
  abrirEmpNuevo, abrirEmpEditar, guardarEmp, setLegajoId, puedeVerInactivos,
}: TabEmpleadosProps) {
  return (
    <>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        <select className="search" style={{width:160}} value={empFiltLocal} onChange={e => setEmpFiltLocal(e.target.value)}>
          {!esEnc && <option value="">Todos los locales</option>}
          {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
        </select>
        <input className="search" placeholder="Buscar..." value={empSearch} onChange={e => setEmpSearch(e.target.value)} style={{width:160}} />
        {puedeVerInactivos && (
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"var(--muted2)",cursor:"pointer"}}>
            <input type="checkbox" checked={empMostrarInactivos} onChange={e => setEmpMostrarInactivos(e.target.checked)} />
            Mostrar inactivos
          </label>
        )}
        <div style={{flex:1}} />
        <button className="btn btn-acc" onClick={abrirEmpNuevo}>+ Nuevo empleado</button>
      </div>
      <div className="panel">
        {empsFilt.length === 0 ? <div className="empty">Sin empleados</div> : (
          <div style={{overflowX:"auto"}}>
          <table><thead><tr><th>Nombre</th><th>Local</th><th>Puesto</th><th style={{textAlign:"right"}}>Sueldo</th><th>Vacaciones</th><th>Alertas</th><th>Activo</th><th></th></tr></thead>
          <tbody>{empsFilt.map(e => {
            const vac = calcularVacaciones(e.fecha_inicio, vacTomadas[e.id] || 0);
            const vacColor = vac >= 14 ? "var(--success)" : vac >= 7 ? "var(--warn)" : "var(--muted2)";
            const alertas: string[] = [];
            if (!e.cuil || e.cuil.trim() === "") alertas.push("Sin CUIL");
            if (!e.fecha_inicio) alertas.push("Sin fecha inicio");
            if (!e.sueldo_mensual || e.sueldo_mensual <= 0) alertas.push("Sin sueldo");
            if (!e.puesto) alertas.push("Sin puesto");
            return (
              <tr key={e.id} style={{opacity: e.activo === false ? 0.4 : 1}}>
                <td style={{fontWeight:500,fontSize:12}}>{e.apellido}, {e.nombre}</td>
                <td style={{fontSize:11}}>{locales.find(l => String(l.id) === String(e.local_id))?.nombre || "—"}</td>
                <td><span className="badge b-muted" style={{fontSize:8}}>{e.puesto}</span></td>
                <td style={{textAlign:"right"}}><span className="num kpi-acc">{fmt_$(e.sueldo_mensual)}</span></td>
                <td style={{fontSize:11,color:vacColor}}>{vac >= 14 && "🌴 "}{vac.toFixed(1)}d</td>
                <td>{alertas.length > 0
                  ? <span className="badge b-warn" style={{fontSize:8}} title={alertas.join(", ")}>⚠ {alertas.length} alerta{alertas.length > 1 ? "s" : ""}</span>
                  : <span className="badge b-success" style={{fontSize:8}}>✓ Completo</span>
                }</td>
                <td><span className={`badge ${e.activo !== false ? "b-success" : "b-muted"}`} style={{fontSize:8}}>{e.activo !== false ? "Si" : "No"}</span></td>
                <td><div style={{display:"flex",gap:4}}>
                  <button className="btn btn-ghost btn-sm" style={{fontSize:9}} onClick={() => setLegajoId(e.id)}>Legajo</button>
                  <button className="btn btn-ghost btn-sm" style={{fontSize:9}} onClick={() => abrirEmpEditar(e)}>Editar</button>
                </div></td>
              </tr>
            );
          })}</tbody></table>
          </div>
        )}
      </div>

      {empModal && (
        <div className="overlay" onClick={() => setEmpModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">{empModal === "new" ? "Nuevo Empleado" : "Editar Empleado"}</div><button className="close-btn" onClick={() => setEmpModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Apellido *</label><input value={empForm.apellido} onChange={e => setEmpForm({...empForm, apellido:e.target.value})} /></div>
                <div className="field"><label>Nombre *</label><input value={empForm.nombre} onChange={e => setEmpForm({...empForm, nombre:e.target.value})} /></div>
              </div>
              <div className="form2">
                <div className="field"><label>Local *</label><select value={empForm.local_id} onChange={e => setEmpForm({...empForm, local_id:e.target.value})}><option value="">Seleccionar...</option>{locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
                <div className="field"><label>CUIL</label><input value={empForm.cuil} onChange={e => setEmpForm({...empForm, cuil:e.target.value})} placeholder="XX-XXXXXXXX-X" /></div>
              </div>
              <div className="field"><label>Puesto *</label><select value={empForm.puesto} onChange={e => setEmpForm({...empForm, puesto:e.target.value})}><option value="">Seleccionar...</option>{puestos.map(p => <option key={p} value={p}>{p}</option>)}<option value="__otro">-- Otro --</option></select>
                {empForm.puesto === "__otro" && <input style={{marginTop:4}} placeholder="Escribir puesto..." onChange={e => setEmpForm({...empForm, puesto:e.target.value})} />}
              </div>
              <div className="form3">
                <div className="field"><label>Sueldo mensual *</label><input type="number" value={empForm.sueldo_mensual} onChange={e => setEmpForm({...empForm, sueldo_mensual:e.target.value})} placeholder="0" /></div>
                <div className="field"><label>CBU / Alias</label><input value={empForm.alias_mp} onChange={e => setEmpForm({...empForm, alias_mp:e.target.value})} /></div>
                <div className="field"><label>Fecha inicio *</label><input type="date" required value={empForm.fecha_inicio} onChange={e => setEmpForm({...empForm, fecha_inicio:e.target.value})} /></div>
              </div>
              <div className="field"><label>Activo</label><select value={empForm.activo ? "1" : "0"} onChange={e => setEmpForm({...empForm, activo:e.target.value === "1"})}><option value="1">Si</option><option value="0">No</option></select></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={() => setEmpModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEmp} disabled={!empForm.apellido || !empForm.nombre || !empForm.local_id || !empForm.puesto || !empForm.sueldo_mensual || !empForm.fecha_inicio}>Guardar</button></div>
          </div>
        </div>
      )}
    </>
  );
}
