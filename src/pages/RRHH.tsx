import { useState, useEffect, useRef } from "react";
import { db } from "../lib/supabase";
import { tienePermiso, localesVisibles } from "../lib/auth";
import { toISO, today, fmt_d, fmt_$ } from "../lib/utils";
import RRHHLegajo from "./RRHHLegajo";

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function calcSueldoBase(modo_pago: string, sueldo_mensual: number) {
  if (modo_pago === "QUINCENAL") return sueldo_mensual / 2;
  if (modo_pago === "SEMANAL") return sueldo_mensual / 4;
  return sueldo_mensual;
}

function calcLiquidacion(emp: any, nov: any, valorDoble: number) {
  const valor_dia = emp.sueldo_mensual / 30;
  const valor_hora = valor_dia / 8;
  const sueldo_base = calcSueldoBase(emp.modo_pago, emp.sueldo_mensual);
  const descuento_ausencias = (nov.inasistencias || 0) * valor_dia;
  const total_horas_extras = (nov.horas_extras || 0) * valor_hora;
  const total_dobles = (nov.dobles || 0) * valorDoble;
  const total_feriados = (nov.feriados || 0) * valor_dia;
  const total_vacaciones = (nov.vacaciones_dias || 0) * valor_dia;
  const subtotal1 = sueldo_base - descuento_ausencias + total_horas_extras + total_dobles + total_feriados + total_vacaciones;
  const monto_presentismo = nov.presentismo === "MANTIENE" ? emp.sueldo_mensual * 0.05 : 0;
  const subtotal2 = subtotal1 + monto_presentismo;
  const total_a_pagar = subtotal2 - (nov.adelantos || 0) - (nov.pagos_dobles_realizados || 0);
  return {
    sueldo_base, descuento_ausencias, total_horas_extras, total_dobles, total_feriados,
    total_vacaciones, subtotal1, monto_presentismo, subtotal2,
    adelantos: nov.adelantos || 0, pagos_realizados: nov.pagos_dobles_realizados || 0,
    total_a_pagar,
    efectivo: emp.alias_mp ? 0 : Math.max(total_a_pagar, 0),
    transferencia: emp.alias_mp ? Math.max(total_a_pagar, 0) : 0,
  };
}

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const PRESENTISMO_OPTS = [
  { value:"MANTIENE", label:"Mantiene" },
  { value:"PIERDE", label:"Pierde" },
  { value:"PIERDE_LLEGADAS", label:"Pierde (llegadas)" },
  { value:"INICIO_PARCIAL", label:"Inicio parcial" },
];

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────
export default function RRHH({ user, locales, localActivo }) {
  const [tab, setTab] = useState("novedades");
  const [legajoId, setLegajoId] = useState<string | null>(null);

  // Shared
  const [valoresDoble, setValoresDoble] = useState<any[]>([]);
  const visLocs = localesVisibles(user);
  const locsDisp = visLocs === null ? locales : locales.filter(l => visLocs.includes(l.id));
  const esEnc = user?.rol === "encargado";

  // Empleados tab
  const [empleados, setEmpleados] = useState<any[]>([]);
  const [empLoading, setEmpLoading] = useState(true);
  const [empModal, setEmpModal] = useState<any>(null);
  const defaultLocal = localActivo || (locsDisp.length === 1 ? locsDisp[0]?.id : (esEnc && locsDisp.length ? locsDisp[0].id : ""));
  const [empFiltLocal, setEmpFiltLocal] = useState(defaultLocal);
  const empEmpty = { local_id:"", apellido:"", nombre:"", cuil:"", puesto:"", modo_pago:"MENSUAL", sueldo_mensual:"", alias_mp:"", fecha_inicio:toISO(today), activo:true };
  const [empForm, setEmpForm] = useState(empEmpty);

  // Novedades tab
  const [novMes, setNovMes] = useState(today.getMonth() + 1);
  const [novAnio, setNovAnio] = useState(today.getFullYear());
  const [novLocal, setNovLocal] = useState(defaultLocal);
  const [novEmps, setNovEmps] = useState<any[]>([]);
  const [novMap, setNovMap] = useState<Record<string, any>>({});
  const [novLoading, setNovLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const saveTimers = useRef<Record<string, any>>({});

  // Liquidaciones tab
  const [liqMes, setLiqMes] = useState(today.getMonth() + 1);
  const [liqAnio, setLiqAnio] = useState(today.getFullYear());
  const [liqLocal, setLiqLocal] = useState("");
  const [liqData, setLiqData] = useState<any[]>([]);
  const [liqLoading, setLiqLoading] = useState(false);
  const [liqExpanded, setLiqExpanded] = useState<string | null>(null);

  // Config tab
  const [cfgEdit, setCfgEdit] = useState<any>(null);

  // ─── LOAD FUNCTIONS ────────────────────────────────────────────────────────
  const loadValoresDoble = async () => {
    const { data } = await db.from("rrhh_valores_doble").select("*").order("puesto");
    setValoresDoble(data || []);
  };

  const loadEmpleados = async () => {
    setEmpLoading(true);
    let q = db.from("rrhh_empleados").select("*").order("apellido");
    if (empFiltLocal) q = q.eq("local_id", parseInt(empFiltLocal));
    const { data } = await q;
    setEmpleados(data || []);
    setEmpLoading(false);
  };

  const loadNovedades = async () => {
    if (!novLocal) return;
    setNovLoading(true);
    const { data: emps } = await db.from("rrhh_empleados").select("*").eq("local_id", parseInt(novLocal)).eq("activo", true).order("apellido");
    const empIds = (emps || []).map(e => e.id);
    let novs: any[] = [];
    if (empIds.length) {
      const { data } = await db.from("rrhh_novedades").select("*").eq("mes", novMes).eq("anio", novAnio).in("empleado_id", empIds);
      novs = data || [];
    }
    const map: Record<string, any> = {};
    (emps || []).forEach(e => {
      const existing = novs.find(n => n.empleado_id === e.id);
      map[e.id] = existing || { inasistencias:0, presentismo:"MANTIENE", dias_trabajados:null, horas_extras:0, dobles:0, pagos_dobles_realizados:0, feriados:0, adelantos:0, vacaciones_dias:0, observaciones:"", estado:"borrador" };
    });
    setNovEmps(emps || []);
    setNovMap(map);
    setNovLoading(false);
  };

  const loadLiquidaciones = async () => {
    setLiqLoading(true);
    // Load all novedades + liquidaciones for the month
    let q = db.from("rrhh_novedades").select("*, rrhh_liquidaciones(*), rrhh_empleados(*)").eq("mes", liqMes).eq("anio", liqAnio).eq("estado", "confirmado");
    if (liqLocal) q = q.eq("rrhh_empleados.local_id", parseInt(liqLocal));
    const { data } = await q;
    setLiqData(data || []);
    setLiqLoading(false);
  };

  useEffect(() => { loadValoresDoble(); }, []);
  useEffect(() => { loadEmpleados(); }, [empFiltLocal]);
  useEffect(() => { if (novLocal) loadNovedades(); }, [novLocal, novMes, novAnio]);
  useEffect(() => { if (tab === "liquidaciones") loadLiquidaciones(); }, [tab, liqMes, liqAnio, liqLocal]);

  // ─── EMPLEADOS ACTIONS ─────────────────────────────────────────────────────
  const puestos = [...new Set(valoresDoble.map(v => v.puesto))];

  const guardarEmp = async () => {
    if (!empForm.apellido || !empForm.nombre || !empForm.local_id || !empForm.puesto || !empForm.sueldo_mensual) return;
    const payload = { ...empForm, local_id: parseInt(empForm.local_id), sueldo_mensual: parseFloat(empForm.sueldo_mensual) || 0 };
    if (empModal?.id) {
      // Registrar historial si el sueldo cambió
      const sueldoAnterior = Number(empModal.sueldo_mensual);
      const sueldoNuevo = payload.sueldo_mensual;
      if (sueldoAnterior !== sueldoNuevo && sueldoAnterior > 0) {
        await db.from("rrhh_historial_sueldos").insert([{
          empleado_id: empModal.id, sueldo_anterior: sueldoAnterior,
          sueldo_nuevo: sueldoNuevo, motivo: "Edición desde listado",
          registrado_por: user?.id,
        }]);
      }
      const { valor_dia, valor_hora, creado_at, vacaciones_dias_acumulados, aguinaldo_acumulado, ...upd } = payload as any;
      await db.from("rrhh_empleados").update(upd).eq("id", empModal.id);
    } else {
      await db.from("rrhh_empleados").insert([payload]);
    }
    setEmpModal(null); loadEmpleados();
  };

  const abrirEmpNuevo = () => { setEmpForm({ ...empEmpty, local_id: empFiltLocal || "" }); setEmpModal("new"); };
  const abrirEmpEditar = (e) => {
    setEmpForm({ local_id:e.local_id ? String(e.local_id) : "", apellido:e.apellido, nombre:e.nombre, cuil:e.cuil||"", puesto:e.puesto, modo_pago:e.modo_pago, sueldo_mensual:String(e.sueldo_mensual), alias_mp:e.alias_mp||"", fecha_inicio:e.fecha_inicio||"", activo:e.activo });
    setEmpModal(e);
  };

  // ─── NOVEDADES ACTIONS ─────────────────────────────────────────────────────
  const updateNov = (empId: string, field: string, value: any) => {
    setNovMap(prev => {
      const updated = { ...prev, [empId]: { ...prev[empId], [field]: value } };
      // Debounce save
      if (saveTimers.current[empId]) clearTimeout(saveTimers.current[empId]);
      saveTimers.current[empId] = setTimeout(() => saveNovedad(empId, updated[empId]), 800);
      return updated;
    });
  };

  const saveNovedad = async (empId: string, nov: any) => {
    const { id, estado, ...rest } = nov;
    await db.from("rrhh_novedades").upsert({
      ...(id ? { id } : {}),
      empleado_id: empId, mes: novMes, anio: novAnio,
      ...rest, estado: estado || "borrador",
      cargado_por: user?.id, updated_at: new Date().toISOString(),
    }, { onConflict: "empleado_id,mes,anio" });
  };

  const confirmarMes = async () => {
    if (!novLocal || confirming) return;
    setConfirming(true);
    for (const emp of novEmps) {
      const nov = novMap[emp.id];
      if (!nov) continue;
      const { data: saved } = await db.from("rrhh_novedades").upsert({
        ...(nov.id ? { id: nov.id } : {}),
        empleado_id: emp.id, mes: novMes, anio: novAnio,
        inasistencias: nov.inasistencias || 0, presentismo: nov.presentismo || "MANTIENE",
        dias_trabajados: nov.dias_trabajados, horas_extras: nov.horas_extras || 0,
        dobles: nov.dobles || 0, pagos_dobles_realizados: nov.pagos_dobles_realizados || 0,
        feriados: nov.feriados || 0, adelantos: nov.adelantos || 0,
        vacaciones_dias: nov.vacaciones_dias || 0, observaciones: nov.observaciones || "",
        estado: "confirmado", cargado_por: user?.id, updated_at: new Date().toISOString(),
      }, { onConflict: "empleado_id,mes,anio" }).select().single();

      if (saved) {
        const vd = valoresDoble.find(v => v.puesto === emp.puesto)?.valor || 0;
        const calc = calcLiquidacion(emp, nov, vd);
        await db.from("rrhh_liquidaciones").upsert({
          novedad_id: saved.id, ...calc, calculado_at: new Date().toISOString(),
        }, { onConflict: "novedad_id" });
      }
    }
    setConfirming(false);
    loadNovedades();
  };

  const reabrirMes = async () => {
    if (!novLocal) return;
    const ids = Object.values(novMap).filter(n => n.id && n.estado === "confirmado").map(n => n.id);
    if (!ids.length) return;
    await db.from("rrhh_liquidaciones").delete().in("novedad_id", ids);
    await db.from("rrhh_novedades").update({ estado: "borrador" }).in("id", ids);
    loadNovedades();
  };

  const allConfirmado = novEmps.length > 0 && novEmps.every(e => novMap[e.id]?.estado === "confirmado");
  const canConfirm = novEmps.length > 0 && novEmps.every(e => novMap[e.id]?.presentismo);

  // ─── LIQUIDACIONES HELPERS ─────────────────────────────────────────────────
  // Group by local
  const liqByLocal: Record<string, any[]> = {};
  liqData.forEach(n => {
    const emp = n.rrhh_empleados;
    const lid = emp?.local_id || "?";
    if (!liqByLocal[lid]) liqByLocal[lid] = [];
    liqByLocal[lid].push(n);
  });

  const exportCSV = () => {
    const rows = [["Apellido","Nombre","Local","Total","Efectivo","Transferencia","Alias MP"]];
    liqData.forEach(n => {
      const emp = n.rrhh_empleados;
      const liq = (n.rrhh_liquidaciones || [])[0];
      if (!liq) return;
      const localName = locales.find(l => l.id === emp?.local_id)?.nombre || "";
      rows.push([emp?.apellido, emp?.nombre, localName, liq.total_a_pagar, liq.efectivo, liq.transferencia, emp?.alias_mp || ""]);
    });
    const csv = rows.map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `liquidaciones_${novAnio}_${String(liqMes).padStart(2,"0")}.csv`; a.click();
  };

  // ─── CONFIG ACTIONS ────────────────────────────────────────────────────────
  const guardarValorDoble = async (item: any) => {
    if (!item.puesto || !item.valor) return;
    await db.from("rrhh_valores_doble").upsert({ ...item, valor: parseFloat(item.valor), updated_at: new Date().toISOString() }, { onConflict: "puesto" });
    setCfgEdit(null); loadValoresDoble();
  };

  const agregarPuesto = async () => {
    const puesto = prompt("Nombre del puesto (MAYÚSCULAS):");
    if (!puesto) return;
    const valor = prompt("Valor del doble ($):");
    if (!valor) return;
    await db.from("rrhh_valores_doble").insert([{ puesto: puesto.toUpperCase(), valor: parseFloat(valor) || 0 }]);
    loadValoresDoble();
  };

  // ─── RENDER ────────────────────────────────────────────────────────────────
  const inp = { padding:"4px 6px", background:"var(--bg)", border:"1px solid var(--bd)", color:"var(--txt)", fontFamily:"'DM Mono',monospace", fontSize:11, borderRadius:"var(--r)", textAlign:"center" as const };
  const esDueno = user?.rol === "dueno" || user?.rol === "admin";

  const tabs = [
    { id:"novedades", label:"Novedades" },
    { id:"empleados", label:"Empleados" },
    ...(esDueno ? [{ id:"liquidaciones", label:"Liquidaciones" }] : []),
    ...(esDueno ? [{ id:"config", label:"Configuración" }] : []),
  ];

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">RRHH</div><div className="ph-sub">Recursos Humanos — Novedades, Liquidaciones y Empleados</div></div>
      </div>

      <div className="tabs">
        {tabs.map(t => <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</div>)}
      </div>

      {/* ─── EMPLEADOS TAB ───────────────────────────────────────────────────── */}
      {tab === "empleados" && (<>
        <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
          <select className="search" style={{ width:180 }} value={empFiltLocal} onChange={e => setEmpFiltLocal(e.target.value)}>
            {!esEnc && <option value="">Todos los locales</option>}
            {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
          </select>
          <button className="btn btn-acc" onClick={abrirEmpNuevo}>+ Nuevo empleado</button>
        </div>
        <div className="panel">
          {empLoading ? <div className="loading">Cargando...</div> : empleados.length === 0 ? <div className="empty">Sin empleados</div> : (
            <div style={{ overflowX:"auto" }}>
            <table><thead><tr><th>Apellido y nombre</th><th>Local</th><th>Puesto</th><th>Modo pago</th><th style={{textAlign:"right"}}>Sueldo</th><th style={{textAlign:"right"}}>Valor día</th><th>Alias MP</th><th>Inicio</th><th>Activo</th><th></th></tr></thead>
            <tbody>{empleados.map(e => (
              <tr key={e.id} style={{ opacity: e.activo === false ? 0.4 : 1 }}>
                <td style={{ fontWeight:500 }}>{e.apellido}, {e.nombre}</td>
                <td style={{ fontSize:11 }}>{locales.find(l => l.id === e.local_id)?.nombre || "—"}</td>
                <td><span className="badge b-muted">{e.puesto}</span></td>
                <td style={{ fontSize:10, color:"var(--muted2)" }}>{e.modo_pago}</td>
                <td style={{ textAlign:"right" }}><span className="num kpi-acc">{fmt_$(e.sueldo_mensual)}</span></td>
                <td style={{ textAlign:"right", fontSize:11, color:"var(--muted2)" }}>{fmt_$(Number(e.valor_dia))}</td>
                <td className="mono" style={{ fontSize:10, color:"var(--muted2)" }}>{e.alias_mp || "—"}</td>
                <td className="mono" style={{ fontSize:11 }}>{fmt_d(e.fecha_inicio)}</td>
                <td><span className={`badge ${e.activo !== false ? "b-success" : "b-muted"}`}>{e.activo !== false ? "Si" : "No"}</span></td>
                <td><div style={{display:"flex",gap:4}}><button className="btn btn-ghost btn-sm" onClick={() => setLegajoId(e.id)}>Legajo</button><button className="btn btn-ghost btn-sm" onClick={() => abrirEmpEditar(e)}>Editar</button></div></td>
              </tr>
            ))}</tbody></table>
            </div>
          )}
        </div>

        {empModal && (
          <div className="overlay" onClick={() => setEmpModal(null)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-hd"><div className="modal-title">{empModal === "new" ? "Nuevo Empleado" : "Editar Empleado"}</div><button className="close-btn" onClick={() => setEmpModal(null)}>✕</button></div>
              <div className="modal-body">
                <div className="form2">
                  <div className="field"><label>Apellido *</label><input value={empForm.apellido} onChange={e => setEmpForm({ ...empForm, apellido:e.target.value })} /></div>
                  <div className="field"><label>Nombre *</label><input value={empForm.nombre} onChange={e => setEmpForm({ ...empForm, nombre:e.target.value })} /></div>
                </div>
                <div className="form2">
                  <div className="field"><label>Local *</label>
                    <select value={empForm.local_id} onChange={e => setEmpForm({ ...empForm, local_id:e.target.value })}>
                      <option value="">Seleccionar...</option>{locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
                    </select></div>
                  <div className="field"><label>CUIL</label><input value={empForm.cuil} onChange={e => setEmpForm({ ...empForm, cuil:e.target.value })} placeholder="XX-XXXXXXXX-X" /></div>
                </div>
                <div className="form2">
                  <div className="field"><label>Puesto *</label>
                    <select value={empForm.puesto} onChange={e => setEmpForm({ ...empForm, puesto:e.target.value })}>
                      <option value="">Seleccionar...</option>
                      {puestos.map(p => <option key={p} value={p}>{p}</option>)}
                      <option value="__otro">-- Otro --</option>
                    </select>
                    {empForm.puesto === "__otro" && <input style={{ marginTop:4 }} placeholder="Escribir puesto..." onChange={e => setEmpForm({ ...empForm, puesto:e.target.value })} />}
                  </div>
                  <div className="field"><label>Modo de pago *</label>
                    <select value={empForm.modo_pago} onChange={e => setEmpForm({ ...empForm, modo_pago:e.target.value })}>
                      <option value="MENSUAL">Mensual</option><option value="QUINCENAL">Quincenal</option><option value="SEMANAL">Semanal</option>
                    </select></div>
                </div>
                <div className="form3">
                  <div className="field"><label>Sueldo mensual *</label><input type="number" value={empForm.sueldo_mensual} onChange={e => setEmpForm({ ...empForm, sueldo_mensual:e.target.value })} placeholder="0" /></div>
                  <div className="field"><label>Valor día</label><input disabled value={empForm.sueldo_mensual ? fmt_$(parseFloat(empForm.sueldo_mensual) / 30) : "—"} /></div>
                  <div className="field"><label>Valor hora</label><input disabled value={empForm.sueldo_mensual ? fmt_$(parseFloat(empForm.sueldo_mensual) / 30 / 8) : "—"} /></div>
                </div>
                <div className="form2">
                  <div className="field"><label>Alias MP</label><input value={empForm.alias_mp} onChange={e => setEmpForm({ ...empForm, alias_mp:e.target.value })} placeholder="alias.mp" /></div>
                  <div className="field"><label>Fecha inicio</label><input type="date" value={empForm.fecha_inicio} onChange={e => setEmpForm({ ...empForm, fecha_inicio:e.target.value })} /></div>
                </div>
                <div className="field"><label>Activo</label>
                  <select value={empForm.activo ? "1" : "0"} onChange={e => setEmpForm({ ...empForm, activo:e.target.value === "1" })}>
                    <option value="1">Si</option><option value="0">No</option>
                  </select></div>
              </div>
              <div className="modal-ft"><button className="btn btn-sec" onClick={() => setEmpModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEmp}>Guardar</button></div>
            </div>
          </div>
        )}
      </>)}

      {/* ─── NOVEDADES TAB ───────────────────────────────────────────────────── */}
      {tab === "novedades" && (<>
        <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
          <select className="search" style={{ width:100 }} value={novMes} onChange={e => setNovMes(parseInt(e.target.value))}>
            {MESES.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
          </select>
          <input type="number" className="search" style={{ width:80 }} value={novAnio} onChange={e => setNovAnio(parseInt(e.target.value))} />
          <select className="search" style={{ width:180 }} value={novLocal} onChange={e => setNovLocal(e.target.value)}>
            <option value="">Seleccionar local...</option>
            {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
          </select>
        </div>

        {!novLocal ? <div className="alert alert-info">Seleccioná un local para cargar novedades</div> :
         novLoading ? <div className="loading">Cargando...</div> :
         novEmps.length === 0 ? <div className="empty">Sin empleados activos en este local</div> : (
          <div className="panel">
            <div style={{ overflowX:"auto" }}>
            <table>
              <thead><tr>
                <th style={{minWidth:140}}>Empleado</th><th style={{width:60}}>Inasist.</th><th style={{width:120}}>Presentismo</th>
                <th style={{width:60}}>Días trab.</th><th style={{width:60}}>Hs extra</th><th style={{width:60}}>Dobles</th>
                <th style={{width:80}}>Pagos dobles $</th><th style={{width:60}}>Feriados</th><th style={{width:80}}>Adelantos $</th>
                <th style={{width:60}}>Vacac.</th><th style={{width:120}}>Obs.</th><th style={{textAlign:"right",width:90}}>Preview</th><th style={{width:70}}>Estado</th>
              </tr></thead>
              <tbody>{novEmps.map(emp => {
                const nov = novMap[emp.id] || {};
                const locked = nov.estado === "confirmado";
                const vd = valoresDoble.find(v => v.puesto === emp.puesto)?.valor || 0;
                const preview = calcLiquidacion(emp, nov, vd).total_a_pagar;
                return (
                  <tr key={emp.id}>
                    <td style={{ fontWeight:500, fontSize:11 }}>{emp.apellido}, {emp.nombre}</td>
                    <td><input type="number" style={{ ...inp, width:50 }} disabled={locked} value={nov.inasistencias ?? 0}
                      onChange={e => updateNov(emp.id, "inasistencias", parseFloat(e.target.value) || 0)} /></td>
                    <td><select style={{ ...inp, width:110, textAlign:"left" }} disabled={locked} value={nov.presentismo || "MANTIENE"}
                      onChange={e => updateNov(emp.id, "presentismo", e.target.value)}>
                      {PRESENTISMO_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select></td>
                    <td><input type="number" style={{ ...inp, width:50 }} disabled={locked} value={nov.dias_trabajados ?? ""}
                      onChange={e => updateNov(emp.id, "dias_trabajados", e.target.value ? parseFloat(e.target.value) : null)} /></td>
                    <td><input type="number" style={{ ...inp, width:50 }} disabled={locked} value={nov.horas_extras ?? 0}
                      onChange={e => updateNov(emp.id, "horas_extras", parseFloat(e.target.value) || 0)} /></td>
                    <td><input type="number" style={{ ...inp, width:50 }} disabled={locked} value={nov.dobles ?? 0}
                      onChange={e => updateNov(emp.id, "dobles", parseFloat(e.target.value) || 0)} /></td>
                    <td><input type="number" style={{ ...inp, width:70 }} disabled={locked} value={nov.pagos_dobles_realizados ?? 0}
                      onChange={e => updateNov(emp.id, "pagos_dobles_realizados", parseFloat(e.target.value) || 0)} /></td>
                    <td><input type="number" style={{ ...inp, width:50 }} disabled={locked} value={nov.feriados ?? 0}
                      onChange={e => updateNov(emp.id, "feriados", parseFloat(e.target.value) || 0)} /></td>
                    <td><input type="number" style={{ ...inp, width:70 }} disabled={locked} value={nov.adelantos ?? 0}
                      onChange={e => updateNov(emp.id, "adelantos", parseFloat(e.target.value) || 0)} /></td>
                    <td><input type="number" style={{ ...inp, width:50 }} disabled={locked} value={nov.vacaciones_dias ?? 0}
                      onChange={e => updateNov(emp.id, "vacaciones_dias", parseFloat(e.target.value) || 0)} /></td>
                    <td><input style={{ ...inp, width:110, textAlign:"left" }} disabled={locked} value={nov.observaciones || ""}
                      onChange={e => updateNov(emp.id, "observaciones", e.target.value)} /></td>
                    <td style={{ textAlign:"right" }}><span className="num" style={{ color: preview < 0 ? "var(--danger)" : "var(--success)", fontSize:12 }}>{fmt_$(preview)}</span></td>
                    <td><span className={`badge ${nov.estado === "confirmado" ? "b-success" : "b-muted"}`}>{nov.estado === "confirmado" ? "OK" : "Borr."}</span></td>
                  </tr>
                );
              })}</tbody>
            </table>
            </div>
            <div style={{ padding:"12px 16px", display:"flex", justifyContent:"flex-end", gap:8 }}>
              {esDueno && allConfirmado && <button className="btn btn-ghost" onClick={reabrirMes}>Reabrir mes</button>}
              {!allConfirmado && <button className="btn btn-acc" onClick={confirmarMes} disabled={!canConfirm || confirming}>
                {confirming ? "Confirmando..." : "Confirmar mes"}
              </button>}
            </div>
          </div>
        )}
      </>)}

      {/* ─── LIQUIDACIONES TAB ───────────────────────────────────────────────── */}
      {tab === "liquidaciones" && (<>
        <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
          <select className="search" style={{ width:100 }} value={liqMes} onChange={e => setLiqMes(parseInt(e.target.value))}>
            {MESES.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
          </select>
          <input type="number" className="search" style={{ width:80 }} value={liqAnio} onChange={e => setLiqAnio(parseInt(e.target.value))} />
          <select className="search" style={{ width:180 }} value={liqLocal} onChange={e => setLiqLocal(e.target.value)}>
            {!esEnc && <option value="">Todos los locales</option>}
            {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
          </select>
          <button className="btn btn-sec" onClick={exportCSV}>Exportar CSV</button>
        </div>

        {liqLoading ? <div className="loading">Cargando...</div> : liqData.length === 0 ? <div className="empty">Sin liquidaciones confirmadas para este período</div> : (
          <>
            {/* Summary by local */}
            {Object.entries(liqByLocal).map(([lid, novs]) => {
              const localName = locales.find(l => String(l.id) === String(lid))?.nombre || "Sin local";
              const liqs = novs.map(n => (n.rrhh_liquidaciones || [])[0]).filter(Boolean);
              const totalEfectivo = liqs.reduce((s, l) => s + Number(l.efectivo || 0), 0);
              const totalTransf = liqs.reduce((s, l) => s + Number(l.transferencia || 0), 0);
              const totalPagar = liqs.reduce((s, l) => s + Number(l.total_a_pagar || 0), 0);
              const expanded = liqExpanded === lid;

              return (
                <div key={lid} className="panel" style={{ marginBottom:12 }}>
                  <div className="panel-hd" style={{ cursor:"pointer" }} onClick={() => setLiqExpanded(expanded ? null : lid)}>
                    <span className="panel-title">{localName} ({novs.length} empleados)</span>
                    <div style={{ display:"flex", gap:16, fontSize:12 }}>
                      <span>Efectivo: <strong style={{ color:"var(--acc)" }}>{fmt_$(totalEfectivo)}</strong></span>
                      <span>Transf: <strong style={{ color:"var(--info)" }}>{fmt_$(totalTransf)}</strong></span>
                      <span>Total: <strong style={{ color:"var(--success)" }}>{fmt_$(totalPagar)}</strong></span>
                      <span style={{ color:"var(--muted2)" }}>{expanded ? "▲" : "▼"}</span>
                    </div>
                  </div>
                  {expanded && (
                    <div style={{ overflowX:"auto" }}>
                    <table>
                      <thead><tr>
                        <th>Empleado</th><th style={{textAlign:"right"}}>Base</th><th style={{textAlign:"right"}}>-Ausencias</th>
                        <th style={{textAlign:"right"}}>+Hs Extra</th><th style={{textAlign:"right"}}>+Dobles</th><th style={{textAlign:"right"}}>+Feriados</th>
                        <th style={{textAlign:"right"}}>+Vacac.</th><th style={{textAlign:"right"}}>Sub1</th><th style={{textAlign:"right"}}>+Present.</th>
                        <th style={{textAlign:"right"}}>Sub2</th><th style={{textAlign:"right"}}>-Adel.</th><th style={{textAlign:"right"}}>-Pagos</th>
                        <th style={{textAlign:"right"}}>Total</th><th style={{textAlign:"right"}}>Efectivo</th><th style={{textAlign:"right"}}>Transf.</th>
                      </tr></thead>
                      <tbody>{novs.map(n => {
                        const emp = n.rrhh_empleados;
                        const liq = (n.rrhh_liquidaciones || [])[0];
                        if (!liq || !emp) return null;
                        return (
                          <tr key={n.id}>
                            <td style={{ fontWeight:500, fontSize:11 }}>{emp.apellido}, {emp.nombre}</td>
                            <td style={{ textAlign:"right", fontSize:11 }}>{fmt_$(liq.sueldo_base)}</td>
                            <td style={{ textAlign:"right", fontSize:11, color:"var(--danger)" }}>{liq.descuento_ausencias > 0 ? "-"+fmt_$(liq.descuento_ausencias) : "—"}</td>
                            <td style={{ textAlign:"right", fontSize:11 }}>{liq.total_horas_extras > 0 ? fmt_$(liq.total_horas_extras) : "—"}</td>
                            <td style={{ textAlign:"right", fontSize:11 }}>{liq.total_dobles > 0 ? fmt_$(liq.total_dobles) : "—"}</td>
                            <td style={{ textAlign:"right", fontSize:11 }}>{liq.total_feriados > 0 ? fmt_$(liq.total_feriados) : "—"}</td>
                            <td style={{ textAlign:"right", fontSize:11 }}>{liq.total_vacaciones > 0 ? fmt_$(liq.total_vacaciones) : "—"}</td>
                            <td style={{ textAlign:"right", fontSize:11, fontWeight:600 }}>{fmt_$(liq.subtotal1)}</td>
                            <td style={{ textAlign:"right", fontSize:11, color:"var(--success)" }}>{liq.monto_presentismo > 0 ? fmt_$(liq.monto_presentismo) : "—"}</td>
                            <td style={{ textAlign:"right", fontSize:11, fontWeight:600 }}>{fmt_$(liq.subtotal2)}</td>
                            <td style={{ textAlign:"right", fontSize:11, color:"var(--warn)" }}>{liq.adelantos > 0 ? "-"+fmt_$(liq.adelantos) : "—"}</td>
                            <td style={{ textAlign:"right", fontSize:11, color:"var(--warn)" }}>{liq.pagos_realizados > 0 ? "-"+fmt_$(liq.pagos_realizados) : "—"}</td>
                            <td style={{ textAlign:"right" }}><span className="num" style={{ color:"var(--success)" }}>{fmt_$(liq.total_a_pagar)}</span></td>
                            <td style={{ textAlign:"right", fontSize:11 }}>{fmt_$(liq.efectivo)}</td>
                            <td style={{ textAlign:"right", fontSize:11, color:"var(--info)" }}>{fmt_$(liq.transferencia)}</td>
                          </tr>
                        );
                      })}</tbody>
                    </table>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </>)}

      {/* ─── CONFIGURACIÓN TAB ───────────────────────────────────────────────── */}
      {tab === "config" && (<>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <span style={{ fontSize:11, color:"var(--muted2)" }}>Valores de dobles por puesto</span>
          <button className="btn btn-acc btn-sm" onClick={agregarPuesto}>+ Agregar puesto</button>
        </div>
        <div className="panel">
          <table>
            <thead><tr><th>Puesto</th><th style={{textAlign:"right"}}>Valor doble $</th><th></th></tr></thead>
            <tbody>{valoresDoble.map(v => (
              <tr key={v.id}>
                <td style={{ fontWeight:500 }}>{v.puesto}</td>
                <td style={{ textAlign:"right" }}>
                  {cfgEdit?.id === v.id ? (
                    <input type="number" style={{ ...inp, width:100 }} value={cfgEdit.valor}
                      onChange={e => setCfgEdit({ ...cfgEdit, valor:e.target.value })}
                      onKeyDown={e => e.key === "Enter" && guardarValorDoble(cfgEdit)} autoFocus />
                  ) : <span className="num kpi-acc">{fmt_$(v.valor)}</span>}
                </td>
                <td style={{ textAlign:"right" }}>
                  {cfgEdit?.id === v.id ? (
                    <div style={{ display:"flex", gap:4, justifyContent:"flex-end" }}>
                      <button className="btn btn-acc btn-sm" onClick={() => guardarValorDoble(cfgEdit)}>OK</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setCfgEdit(null)}>X</button>
                    </div>
                  ) : <button className="btn btn-ghost btn-sm" onClick={() => setCfgEdit({ ...v })}>Editar</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </>)}

      {/* ─── LEGAJO MODAL ────────────────────────────────────────────────────── */}
      {legajoId && (
        <div className="overlay" onClick={() => { setLegajoId(null); loadEmpleados(); }}>
          <div style={{background:"var(--s1)",border:"1px solid var(--bd2)",borderRadius:"var(--r)",width:"90vw",maxWidth:1100,height:"90vh",display:"flex",flexDirection:"column",overflow:"hidden"}} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Legajo</div>
              <button className="close-btn" onClick={() => { setLegajoId(null); loadEmpleados(); }}>✕</button>
            </div>
            <div style={{flex:1,overflowY:"auto",padding:20}}>
              <RRHHLegajo empleadoId={legajoId} user={user} locales={locales} onClose={() => { setLegajoId(null); loadEmpleados(); }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
