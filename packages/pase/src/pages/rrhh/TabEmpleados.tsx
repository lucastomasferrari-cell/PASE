import { fmt_$ } from "../../lib/utils";
import { calcularVacaciones } from "../../lib/calculos/rrhh";
import { LocalLockedChip, LocalSelectorObligatorio } from "../../components/ui";
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
  /** localActivo del sidebar — si !== null, sucursal viene LOCKED en el modal. */
  localActivo: number | null;
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
  esEnc, locsDisp, locales, localActivo, empsFilt, vacTomadas, puestos,
  empModal, setEmpModal, empForm, setEmpForm,
  abrirEmpNuevo, abrirEmpEditar, guardarEmp, setLegajoId, puedeVerInactivos,
}: TabEmpleadosProps) {
  // Contador "X sin registrar" — solo cuenta los activos (los inactivos
  // no necesitan estar en AFIP). Pedido Lucas 2026-05-17.
  const sinRegistrar = empsFilt.filter(e => e.activo !== false && !(e as { registrado?: boolean }).registrado).length;
  const totalActivos = empsFilt.filter(e => e.activo !== false).length;

  return (
    <>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        <select className="search" style={{width:160}} value={empFiltLocal} onChange={e => setEmpFiltLocal(e.target.value)}>
          {!esEnc && <option value="">Todas las sucursales</option>}
          {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
        </select>
        <input className="search" placeholder="Buscar..." value={empSearch} onChange={e => setEmpSearch(e.target.value)} style={{width:160}} />
        {puedeVerInactivos && (
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"var(--muted2)",cursor:"pointer"}}>
            <input type="checkbox" checked={empMostrarInactivos} onChange={e => setEmpMostrarInactivos(e.target.checked)} />
            Mostrar inactivos
          </label>
        )}
        {sinRegistrar > 0 && (
          <span
            title={`${sinRegistrar} de ${totalActivos} empleados activos no figuran como registrados en AFIP`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "4px 10px", borderRadius: 999,
              background: "rgba(217,119,6,0.12)",
              border: "0.5px solid rgba(217,119,6,0.35)",
              color: "#D97706", fontSize: 11, fontWeight: 500,
            }}
          >
            <span style={{width:6,height:6,borderRadius:"50%",background:"#D97706"}} />
            {sinRegistrar} sin registrar
          </span>
        )}
        <div style={{flex:1}} />
        <button className="btn btn-acc" onClick={abrirEmpNuevo}>+ Nuevo empleado</button>
      </div>
      <div className="panel">
        {empsFilt.length === 0 ? <div className="empty">Sin empleados</div> : (
          <div style={{overflowX:"auto"}}>
          <table><thead><tr><th>Nombre</th><th>Local</th><th>Puesto</th><th style={{textAlign:"right"}}>Sueldo</th><th>Vacaciones</th><th>Registrado</th><th>Alertas</th><th>Activo</th><th></th></tr></thead>
          <tbody>{empsFilt.map(e => {
            // Cálculo de vacaciones corregido (2026-05-17): resta los días que
            // el empleado YA tomó antes del alta en PASE (campo nuevo
            // dias_vacaciones_ya_tomados_al_alta). Default 0 si no se cargó.
            const yaTomadosAlta = (e as { dias_vacaciones_ya_tomados_al_alta?: number }).dias_vacaciones_ya_tomados_al_alta ?? 0;
            const vacTomadasTotal = (vacTomadas[e.id] || 0) + yaTomadosAlta;
            const vac = calcularVacaciones(e.fecha_inicio, vacTomadasTotal);
            const vacColor = vac >= 14 ? "var(--success)" : vac >= 7 ? "var(--warn)" : "var(--muted2)";
            const alertas: string[] = [];
            if (!e.cuil || e.cuil.trim() === "") alertas.push("Sin CUIL");
            if (!e.fecha_inicio) alertas.push("Sin fecha inicio");
            if (!e.sueldo_mensual || e.sueldo_mensual <= 0) alertas.push("Sin sueldo");
            if (!e.puesto) alertas.push("Sin puesto");
            const reg = Boolean((e as { registrado?: boolean }).registrado);
            return (
              <tr key={e.id} style={{opacity: e.activo === false ? 0.4 : 1}}>
                <td style={{fontWeight:500,fontSize:12}}>{e.apellido}, {e.nombre}</td>
                <td style={{fontSize:11}}>{locales.find(l => String(l.id) === String(e.local_id))?.nombre || "—"}</td>
                <td><span className="badge b-muted" style={{fontSize:8}}>{e.puesto}</span></td>
                <td style={{textAlign:"right"}}><span className="num kpi-acc">{fmt_$(e.sueldo_mensual)}</span></td>
                <td style={{fontSize:11,color:vacColor}} title={yaTomadosAlta > 0 ? `Incluye ${yaTomadosAlta}d ya tomados antes del alta` : undefined}>{vac >= 14 && "🌴 "}{vac.toFixed(1)}d</td>
                <td>
                  <span className={`badge ${reg ? "b-success" : ""}`} style={{
                    fontSize:8,
                    ...(reg ? {} : {
                      background: "rgba(217,119,6,0.12)",
                      color: "#D97706",
                      border: "0.5px solid rgba(217,119,6,0.35)",
                    }),
                  }}>{reg ? "Sí" : "No"}</span>
                </td>
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
                <div className="field"><label>Local *</label>
                  {localActivo !== null ? (
                    <div style={{ paddingTop: 4 }}>
                      <LocalLockedChip nombre={locales.find(l => l.id === localActivo)?.nombre ?? "—"} />
                    </div>
                  ) : locsDisp.length === 1 ? (
                    <input type="text" value={locsDisp[0]!.nombre} disabled readOnly />
                  ) : (
                    <LocalSelectorObligatorio
                      value={empForm.local_id ? Number(empForm.local_id) : null}
                      onChange={id => setEmpForm({ ...empForm, local_id: id !== null ? String(id) : "" })}
                      locales={locsDisp}
                    />
                  )}
                </div>
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
              <div className="form3">
                <div className="field"><label>Activo</label><select value={empForm.activo ? "1" : "0"} onChange={e => setEmpForm({...empForm, activo:e.target.value === "1"})}><option value="1">Si</option><option value="0">No</option></select></div>
                <div className="field">
                  <label title="TRUE si está en nómina formal AFIP. Sirve para identificar empleados 'en blanco' vs 'en negro'.">Registrado (AFIP)</label>
                  <select value={empForm.registrado ? "1" : "0"} onChange={e => setEmpForm({...empForm, registrado: e.target.value === "1"})}>
                    <option value="0">No</option>
                    <option value="1">Sí</option>
                  </select>
                </div>
                <div className="field">
                  <label title="Días de vacaciones que ya consumió ANTES de cargarlo en PASE. Se restan al cálculo automático por antigüedad.">Vacaciones ya tomadas (al alta)</label>
                  <input type="number" min={0} value={empForm.dias_vacaciones_ya_tomados_al_alta} onChange={e => setEmpForm({...empForm, dias_vacaciones_ya_tomados_al_alta: e.target.value})} placeholder="0" />
                </div>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={() => setEmpModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEmp} disabled={!empForm.apellido || !empForm.nombre || !empForm.local_id || !empForm.puesto || !empForm.sueldo_mensual || !empForm.fecha_inicio}>Guardar</button></div>
          </div>
        </div>
      )}
    </>
  );
}
