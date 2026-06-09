import { useEffect, useState } from "react";
import { fmt_$ } from "@pase/shared/utils";
import { calcularVacaciones, enPeriodoPrueba } from "../../lib/calculos/rrhh";
import { LocalLockedChip, LocalSelectorObligatorio, Modal } from "../../components/ui";
import type { Local } from "../../types";
import type { Empleado } from "../../types/rrhh";
import type { EmpForm, EmpModalState } from "./types";

interface TabEmpleadosProps {
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
  guardarEmp: () => Promise<void | undefined>;
  guardandoEmp: boolean;
  setLegajoId: React.Dispatch<React.SetStateAction<string | null>>;
  puedeVerInactivos: boolean;
}

export function TabEmpleados({
  empSearch, setEmpSearch,
  empMostrarInactivos, setEmpMostrarInactivos,
  esEnc: _esEnc, locsDisp, locales, localActivo, empsFilt, vacTomadas, puestos,
  empModal, setEmpModal, empForm, setEmpForm,
  abrirEmpNuevo, abrirEmpEditar, guardarEmp, guardandoEmp, setLegajoId, puedeVerInactivos,
}: TabEmpleadosProps) {
  // Contador "X sin registrar" — solo cuenta los activos (los inactivos
  // no necesitan estar en AFIP). Pedido Lucas 2026-05-17.
  const sinRegistrar = empsFilt.filter(e => e.activo !== false && !(e as { registrado?: boolean }).registrado).length;
  const totalActivos = empsFilt.filter(e => e.activo !== false).length;

  // Flag separado para "Puesto custom". Bug 2026-05-18: antes el input
  // "Escribir puesto..." se mostraba si `puesto === '__otro'`, pero al
  // escribir la primera letra el value cambiaba y el input desaparecía.
  // Ahora el flag se setea al elegir "Otro" en el select y se mantiene
  // hasta que se cierre el modal o se elija otro puesto del catálogo.
  const [usandoOtroPuesto, setUsandoOtroPuesto] = useState(false);

  // Si el modal abre con un empleado cuyo puesto NO está en el catálogo
  // (puesto legacy o creado ad-hoc antes), arrancamos en modo "Otro" con
  // el valor pre-cargado para que el cajero pueda editarlo.
  /* eslint-disable react-hooks/set-state-in-effect -- intencional: hidratar el modo "Otro" cuando el modal abre con un empleado cuyo puesto no está en el catálogo. Es un sync de fuente externa (empModal cambia desde la tabla), no un efecto en cascada. */
  useEffect(() => {
    if (empModal === null) {
      setUsandoOtroPuesto(false);
      return;
    }
    if (empForm.puesto && !puestos.includes(empForm.puesto)) {
      setUsandoOtroPuesto(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empModal]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        <input className="search" placeholder="Buscar..." value={empSearch} onChange={e => setEmpSearch(e.target.value)} style={{width:200}} />
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
            const enPrueba = enPeriodoPrueba(e.fecha_inicio);
            return (
              <tr key={e.id} style={{opacity: e.activo === false ? 0.4 : 1}}>
                <td style={{fontWeight:500,fontSize:12}}>{e.apellido}, {e.nombre}</td>
                <td style={{fontSize:11}}>{locales.find(l => String(l.id) === String(e.local_id))?.nombre || "—"}</td>
                <td>
                  <span className="badge b-muted" style={{fontSize:8}}>{e.puesto}</span>
                  {enPrueba && (
                    <div style={{marginTop:3}}>
                      <span
                        title="En período de prueba — primeros 6 meses desde el ingreso (LCT Art. 92 bis)"
                        style={{
                          display:"inline-flex",alignItems:"center",gap:4,
                          padding:"2px 7px",borderRadius:999,
                          background:"rgba(37,99,235,0.12)",
                          border:"0.5px solid rgba(37,99,235,0.35)",
                          color:"#2563EB",fontSize:9,fontWeight:500,
                        }}
                      >🧪 En prueba</span>
                    </div>
                  )}
                </td>
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

      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido. */}
      <Modal
        isOpen={!!empModal}
        onClose={() => setEmpModal(null)}
        title={empModal === "new" ? "Nuevo Empleado" : "Editar Empleado"}
        preventCloseOnOverlay={guardandoEmp}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setEmpModal(null)} disabled={guardandoEmp}>Cancelar</button>
            <button className="btn btn-acc" onClick={guardarEmp} disabled={guardandoEmp || !empForm.apellido || !empForm.nombre || !empForm.local_id || !empForm.puesto || !empForm.sueldo_mensual || !empForm.fecha_inicio}>{guardandoEmp ? "Guardando…" : "Guardar"}</button>
          </>
        }
      >
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
        <div className="field"><label>Puesto *</label>
          <select
            value={usandoOtroPuesto ? "__otro" : empForm.puesto}
            onChange={e => {
              if (e.target.value === "__otro") {
                setUsandoOtroPuesto(true);
                setEmpForm({ ...empForm, puesto: "" });
              } else {
                setUsandoOtroPuesto(false);
                setEmpForm({ ...empForm, puesto: e.target.value });
              }
            }}
          >
            <option value="">Seleccionar...</option>
            {puestos.map(p => <option key={p} value={p}>{p}</option>)}
            <option value="__otro">-- Otro (escribir nuevo) --</option>
          </select>
          {usandoOtroPuesto && (
            <input
              style={{ marginTop: 4 }}
              placeholder="Escribir puesto nuevo..."
              value={empForm.puesto}
              onChange={e => setEmpForm({ ...empForm, puesto: e.target.value })}
              autoFocus
            />
          )}
        </div>
        <div className="form3">
          <div className="field"><label>Sueldo mensual *</label><input type="number" value={empForm.sueldo_mensual} onChange={e => setEmpForm({...empForm, sueldo_mensual:e.target.value})} placeholder="0" /></div>
          <div className="field"><label>CBU / Alias</label><input value={empForm.alias_mp} onChange={e => setEmpForm({...empForm, alias_mp:e.target.value})} /></div>
          <div className="field"><label>Fecha inicio *</label><input type="date" required value={empForm.fecha_inicio} onChange={e => setEmpForm({...empForm, fecha_inicio:e.target.value})} /></div>
        </div>
        <div className="form3">
          <div className="field">
            <label title="Cada cuántos días se le paga. Cambia cuántas cuotas se generan al confirmar la novedad mensual: Mensual=1, Quincenal=2, Semanal=4. El sueldo mensual no cambia.">Forma de pago *</label>
            <select value={empForm.modo_pago} onChange={e => setEmpForm({...empForm, modo_pago: e.target.value as "MENSUAL" | "QUINCENAL" | "SEMANAL"})}>
              <option value="MENSUAL">Mensual (1 pago/mes)</option>
              <option value="QUINCENAL">Quincenal (2 pagos/mes)</option>
              <option value="SEMANAL">Semanal (4 pagos/mes)</option>
            </select>
          </div>
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
      </Modal>
    </>
  );
}
