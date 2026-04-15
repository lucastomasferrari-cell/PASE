import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";

const MESES = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const DOC_TIPOS = [
  { value:"alta_temprana", label:"Alta temprana" },
  { value:"dni", label:"DNI" },
  { value:"recibo_sueldo", label:"Recibo de sueldo" },
  { value:"baja", label:"Baja" },
  { value:"contrato", label:"Contrato" },
  { value:"otro", label:"Otro" },
];

function diasVacacionesPorAnio(antiguedadAnios: number): number {
  if (antiguedadAnios < 5) return 14;
  if (antiguedadAnios < 10) return 21;
  if (antiguedadAnios < 20) return 28;
  return 35;
}

export default function RRHHLegajo({ empleadoId, user, locales, onClose }) {
  const [emp, setEmp] = useState<any>(null);
  const [tab, setTab] = useState("datos");
  const [loading, setLoading] = useState(true);

  // Datos
  const [histSueldos, setHistSueldos] = useState<any[]>([]);
  const [sueldoModal, setSueldoModal] = useState(false);
  const [sueldoForm, setSueldoForm] = useState({ monto:"", motivo:"" });

  // Movimientos
  const [movMeses, setMovMeses] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pagando, setPagando] = useState(false);

  // Vacaciones/Aguinaldo
  const [pagosEsp, setPagosEsp] = useState<any[]>([]);
  const [vacTomadas, setVacTomadas] = useState(0);
  const [vacModal, setVacModal] = useState(false);
  const [vacDias, setVacDias] = useState("");
  const [aguModal, setAguModal] = useState(false);

  // Documentos
  const [docs, setDocs] = useState<any[]>([]);
  const [docModal, setDocModal] = useState(false);
  const [docForm, setDocForm] = useState({ tipo:"otro", mes:"", anio:"" });
  const [uploading, setUploading] = useState(false);

  // Liquidación final
  const [liqFinalModal, setLiqFinalModal] = useState(false);
  const [liqFinalForm, setLiqFinalForm] = useState({ fecha_egreso: toISO(today), motivo: "Renuncia" });

  const [toast, setToast] = useState("");
  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(""), 3000); };
  const esDueno = user?.rol === "dueno" || user?.rol === "admin";

  // ─── LOAD ──────────────────────────────────────────────────────────────────
  const loadEmp = async () => {
    const { data } = await db.from("rrhh_empleados").select("*").eq("id", empleadoId).single();
    setEmp(data);
    return data;
  };

  const loadHistSueldos = async () => {
    const { data } = await db.from("rrhh_historial_sueldos").select("*").eq("empleado_id", empleadoId).order("fecha_cambio", { ascending: false });
    setHistSueldos(data || []);
  };

  const loadMovimientos = async () => {
    const { data: novs } = await db.from("rrhh_novedades").select("*, rrhh_liquidaciones(*)").eq("empleado_id", empleadoId).order("anio", { ascending: false }).order("mes", { ascending: false });
    setMovMeses(novs || []);
  };

  const loadVacTomadas = async () => {
    const { data } = await db.from("rrhh_novedades").select("vacaciones_dias").eq("empleado_id", empleadoId).eq("estado", "confirmado").gt("vacaciones_dias", 0);
    const total = (data || []).reduce((s, n) => s + Number(n.vacaciones_dias || 0), 0);
    setVacTomadas(total);
  };

  const loadPagosEsp = async () => {
    const { data } = await db.from("rrhh_pagos_especiales").select("*").eq("empleado_id", empleadoId).order("pagado_at", { ascending: false });
    setPagosEsp(data || []);
  };

  const loadDocs = async () => {
    const { data } = await db.from("rrhh_documentos").select("*").eq("empleado_id", empleadoId).order("subido_at", { ascending: false });
    setDocs(data || []);
  };

  const loadAll = async () => {
    setLoading(true);
    await Promise.all([loadEmp(), loadHistSueldos(), loadMovimientos(), loadPagosEsp(), loadDocs(), loadVacTomadas()]);
    setLoading(false);
  };

  useEffect(() => { loadAll(); }, [empleadoId]);

  if (loading || !emp) return <div className="loading">Cargando legajo...</div>;

  const localNombre = locales.find(l => l.id === emp.local_id)?.nombre || "—";
  const valorDia = emp.sueldo_mensual / 30;

  // Antigüedad
  const fechaInicio = emp.fecha_inicio ? new Date(emp.fecha_inicio + "T12:00:00") : null;
  const antiguedadMs = fechaInicio ? Date.now() - fechaInicio.getTime() : 0;
  const antiguedadAnios = antiguedadMs / (365.25 * 24 * 60 * 60 * 1000);
  const diasVacAnuales = diasVacacionesPorAnio(Math.floor(antiguedadAnios));
  const diasVacPorMes = diasVacAnuales / 12;
  const mesesTrabajados = fechaInicio ? (new Date().getFullYear() - fechaInicio.getFullYear()) * 12 + (new Date().getMonth() - fechaInicio.getMonth()) : 0;
  const vacAcumuladas = Math.max(0, diasVacPorMes * Math.max(0, mesesTrabajados) - vacTomadas);

  // SAC teórico
  const mesActual = new Date().getMonth() + 1;
  const mesesEnSemestre = mesActual <= 6 ? mesActual : mesActual - 6;
  const sacAcumulado = (Number(emp.sueldo_mensual) / 12) * mesesEnSemestre;
  const sacTeorico = Number(emp.sueldo_mensual) / 2;

  // ─── ACCIONES: SUELDO ──────────────────────────────────────────────────────
  const guardarSueldo = async () => {
    const nuevo = parseFloat(sueldoForm.monto);
    if (!nuevo || nuevo === emp.sueldo_mensual) return;
    await db.from("rrhh_historial_sueldos").insert([{
      empleado_id: emp.id, sueldo_anterior: emp.sueldo_mensual,
      sueldo_nuevo: nuevo, motivo: sueldoForm.motivo || null,
      registrado_por: user?.id,
    }]);
    await db.from("rrhh_empleados").update({ sueldo_mensual: nuevo }).eq("id", emp.id);
    setSueldoModal(false); setSueldoForm({ monto:"", motivo:"" });
    loadEmp(); loadHistSueldos();
    showToast("Sueldo actualizado");
  };

  const toggleActivo = async () => {
    await db.from("rrhh_empleados").update({ activo: !emp.activo }).eq("id", emp.id);
    loadEmp();
  };

  // ─── ACCIONES: PAGAR MES ───────────────────────────────────────────────────
  const pagarMes = async (nov: any) => {
    if (pagando) return;
    const liq = (nov.rrhh_liquidaciones || [])[0];
    if (!liq || liq.estado === "pagado") return;
    setPagando(true);

    const desc = `Sueldo ${emp.apellido} ${emp.nombre} - ${MESES[nov.mes]} ${nov.anio}`;
    const gastoId = genId("GASTO");
    await db.from("gastos").insert([{
      id: gastoId, fecha: toISO(today), tipo: "fijo", categoria: "SUELDOS",
      monto: Number(liq.total_a_pagar), detalle: desc,
      local_id: emp.local_id, cuenta: emp.alias_mp ? "MercadoPago" : "Caja Chica",
    }]);

    await db.from("rrhh_liquidaciones").update({
      estado: "pagado", gasto_id: gastoId,
      pagado_at: new Date().toISOString(), pagado_por: user?.id,
    }).eq("id", liq.id);

    // Acumular aguinaldo: sueldo/12
    const aguIncremento = Number(liq.total_a_pagar) / 12;
    await db.from("rrhh_empleados").update({
      aguinaldo_acumulado: (emp.aguinaldo_acumulado || 0) + aguIncremento,
    }).eq("id", emp.id);

    setPagando(false);
    showToast("Pago registrado correctamente");
    loadAll();
  };

  // ─── ACCIONES: VACACIONES ──────────────────────────────────────────────────
  const pagarVacaciones = async () => {
    const dias = parseFloat(vacDias) || vacAcumuladas;
    if (dias <= 0) return;
    const monto = dias * valorDia;
    const desc = `Vacaciones ${emp.apellido} ${emp.nombre}`;
    const gastoId = genId("GASTO");

    await db.from("gastos").insert([{
      id: gastoId, fecha: toISO(today), tipo: "fijo", categoria: "SUELDOS",
      monto, detalle: desc, local_id: emp.local_id, cuenta: "Caja Chica",
    }]);
    await db.from("rrhh_pagos_especiales").insert([{
      empleado_id: emp.id, tipo: "vacaciones", monto, dias,
      gasto_id: gastoId, pagado_por: user?.id,
    }]);
    await db.from("rrhh_empleados").update({ vacaciones_dias_acumulados: 0 }).eq("id", emp.id);

    setVacModal(false); setVacDias("");
    showToast("Vacaciones pagadas");
    loadAll();
  };

  // ─── ACCIONES: AGUINALDO ───────────────────────────────────────────────────
  const pagarAguinaldo = async () => {
    const monto = sacAcumulado;
    if (monto <= 0) return;
    const desc = `Aguinaldo ${emp.apellido} ${emp.nombre}`;
    const gastoId = genId("GASTO");

    await db.from("gastos").insert([{
      id: gastoId, fecha: toISO(today), tipo: "fijo", categoria: "SUELDOS",
      monto, detalle: desc, local_id: emp.local_id, cuenta: "Caja Chica",
    }]);
    await db.from("rrhh_pagos_especiales").insert([{
      empleado_id: emp.id, tipo: "aguinaldo", monto,
      gasto_id: gastoId, pagado_por: user?.id,
    }]);
    await db.from("rrhh_empleados").update({ aguinaldo_acumulado: 0 }).eq("id", emp.id);

    setAguModal(false);
    showToast("Aguinaldo pagado");
    loadAll();
  };

  // ─── ACCIONES: DOCUMENTOS ─────────────────────────────────────────────────
  const subirDoc = async (file: File) => {
    if (!file || uploading) return;
    setUploading(true);
    const ext = file.name.split(".").pop();
    const path = `${emp.id}/${docForm.tipo}/${Date.now()}.${ext}`;
    const { error: upErr } = await db.storage.from("rrhh-documentos").upload(path, file);
    if (upErr) { showToast("Error subiendo: " + upErr.message); setUploading(false); return; }

    // URL firmada 1 hora
    const { data: signedData } = await db.storage.from("rrhh-documentos").createSignedUrl(path, 3600);
    const url = signedData?.signedUrl || path;

    await db.from("rrhh_documentos").insert([{
      empleado_id: emp.id, tipo: docForm.tipo, nombre_archivo: file.name, url: path,
      mes: docForm.mes ? parseInt(docForm.mes) : null, anio: docForm.anio ? parseInt(docForm.anio) : null,
      subido_por: user?.id,
    }]);
    setUploading(false); setDocModal(false); setDocForm({ tipo:"otro", mes:"", anio:"" });
    showToast("Documento subido");
    loadDocs();
  };

  const verDoc = async (doc: any) => {
    const { data } = await db.storage.from("rrhh-documentos").createSignedUrl(doc.url, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  };

  const eliminarDoc = async (doc: any) => {
    if (!confirm("Eliminar documento?")) return;
    await db.storage.from("rrhh-documentos").remove([doc.url]);
    await db.from("rrhh_documentos").delete().eq("id", doc.id);
    loadDocs();
  };

  // ─── RENDER ────────────────────────────────────────────────────────────────
  const tabs = [
    { id:"datos", label:"Datos personales" },
    { id:"movimientos", label:"Movimientos" },
    { id:"vacagu", label:"Vacaciones / Aguinaldo" },
    { id:"documentos", label:"Documentos" },
  ];

  return (
    <div>
      {toast && <div style={{position:"fixed",top:16,right:16,zIndex:300,padding:"10px 20px",background:"var(--success)",color:"#000",borderRadius:"var(--r)",fontSize:12,fontFamily:"'DM Mono',monospace",fontWeight:600,boxShadow:"0 4px 12px rgba(0,0,0,.5)"}}>{toast}</div>}

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,gap:12,flexWrap:"wrap"}}>
        <div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:22,fontWeight:800,lineHeight:1}}>{emp.apellido}, {emp.nombre}</div>
          <div style={{fontSize:11,color:"var(--muted2)",marginTop:4}}>{emp.puesto} · {localNombre} · {emp.modo_pago} · {emp.activo ? "Activo" : "Inactivo"}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:9,letterSpacing:2,textTransform:"uppercase",color:"var(--muted)"}}>Sueldo mensual</div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:20,fontWeight:700,color:"var(--acc)"}}>{fmt_$(emp.sueldo_mensual)}</div>
          <div style={{fontSize:10,color:"var(--muted2)"}}>Día: {fmt_$(valorDia)}</div>
        </div>
      </div>

      <div className="tabs">
        {tabs.map(t => <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</div>)}
      </div>

      {/* ═══ DATOS PERSONALES ═══════════════════════════════════════════════ */}
      {tab === "datos" && (<>
        <div className="grid3" style={{marginBottom:16}}>
          <div className="kpi"><div className="kpi-label">CUIL</div><div style={{fontSize:13}}>{emp.cuil || "—"}</div></div>
          <div className="kpi"><div className="kpi-label">Fecha ingreso</div><div style={{fontSize:13}}>{fmt_d(emp.fecha_inicio)}</div></div>
          <div className="kpi"><div className="kpi-label">Antigüedad</div><div style={{fontSize:13}}>{Math.floor(antiguedadAnios)} años, {Math.floor((antiguedadAnios % 1) * 12)} meses</div></div>
        </div>
        <div className="grid3" style={{marginBottom:16}}>
          <div className="kpi"><div className="kpi-label">Alias MP</div><div style={{fontSize:13}}>{emp.alias_mp || "—"}</div></div>
          <div className="kpi"><div className="kpi-label">Modo de pago</div><div style={{fontSize:13}}>{emp.modo_pago}</div></div>
          <div className="kpi">
            <div className="kpi-label">Estado</div>
            <span className={`badge ${emp.activo ? "b-success" : "b-muted"}`} style={{cursor:"pointer"}} onClick={toggleActivo}>
              {emp.activo ? "Activo" : "Inactivo"}
            </span>
          </div>
        </div>

        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Sueldo actual: {fmt_$(emp.sueldo_mensual)}</span>
            {esDueno && <button className="btn btn-acc btn-sm" onClick={() => { setSueldoForm({ monto:String(emp.sueldo_mensual), motivo:"" }); setSueldoModal(true); }}>Actualizar sueldo</button>}
          </div>
          {histSueldos.length === 0 ? <div className="empty">Sin cambios de sueldo registrados</div> : (
            <table><thead><tr><th>Fecha</th><th style={{textAlign:"right"}}>Anterior</th><th style={{textAlign:"right"}}>Nuevo</th><th>Motivo</th></tr></thead>
            <tbody>{histSueldos.map(h => (
              <tr key={h.id}>
                <td className="mono">{fmt_d(h.fecha_cambio)}</td>
                <td style={{textAlign:"right"}}><span className="num" style={{color:"var(--muted2)"}}>{fmt_$(h.sueldo_anterior)}</span></td>
                <td style={{textAlign:"right"}}><span className="num kpi-acc">{fmt_$(h.sueldo_nuevo)}</span></td>
                <td style={{fontSize:11,color:"var(--muted2)"}}>{h.motivo || "—"}</td>
              </tr>
            ))}</tbody></table>
          )}
        </div>

        {esDueno && emp.activo && (
          <button className="btn btn-danger btn-sm" style={{marginTop:12}} onClick={() => setLiqFinalModal(true)}>Liquidación final</button>
        )}

        {sueldoModal && (
          <div className="overlay" onClick={() => setSueldoModal(false)}>
            <div className="modal" style={{width:420}} onClick={e => e.stopPropagation()}>
              <div className="modal-hd"><div className="modal-title">Actualizar sueldo</div><button className="close-btn" onClick={() => setSueldoModal(false)}>✕</button></div>
              <div className="modal-body">
                <div className="alert alert-info">Sueldo actual: {fmt_$(emp.sueldo_mensual)}</div>
                <div className="field"><label>Nuevo sueldo $</label><input type="number" value={sueldoForm.monto} onChange={e => setSueldoForm({...sueldoForm, monto:e.target.value})} /></div>
                <div className="field"><label>Motivo</label><input value={sueldoForm.motivo} onChange={e => setSueldoForm({...sueldoForm, motivo:e.target.value})} placeholder="Aumento paritarias, promoción..." /></div>
              </div>
              <div className="modal-ft"><button className="btn btn-sec" onClick={() => setSueldoModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardarSueldo}>Guardar</button></div>
            </div>
          </div>
        )}

        {liqFinalModal && (() => {
          const sueldo = Number(emp.sueldo_mensual);
          const vDia = sueldo / 30;
          const fechaEg = new Date(liqFinalForm.fecha_egreso + "T12:00:00");
          const diaDelMes = fechaEg.getDate();
          const proporcionalMes = vDia * diaDelMes;
          const vacDias = vacAcumuladas;
          const vacMonto = vacDias * vDia;
          // SAC proporcional
          const inicioSem = fechaEg.getMonth() < 6 ? new Date(fechaEg.getFullYear(), 0, 1) : new Date(fechaEg.getFullYear(), 6, 1);
          const diasEnSem = Math.ceil((fechaEg.getTime() - inicioSem.getTime()) / 86400000);
          const sacProp = (sueldo / 2) * (diasEnSem / 180);
          const esDespidoSinCausa = liqFinalForm.motivo === "Despido sin causa";
          const antAnios = Math.max(1, Math.floor(antiguedadAnios));
          const indemnizacion = esDespidoSinCausa ? sueldo * antAnios : 0;
          const preaviso = esDespidoSinCausa ? (antiguedadAnios < 5 ? vDia * 15 : sueldo) : 0;
          const diasRestantesMes = new Date(fechaEg.getFullYear(), fechaEg.getMonth() + 1, 0).getDate() - diaDelMes;
          const integracion = esDespidoSinCausa ? vDia * diasRestantesMes : 0;
          const total = proporcionalMes + vacMonto + sacProp + indemnizacion + preaviso + integracion;

          const confirmarLiqFinal = async () => {
            const desc = `Liquidación final ${emp.apellido} ${emp.nombre}`;
            const gastoId = genId("GASTO");
            await db.from("gastos").insert([{ id: gastoId, fecha: toISO(today), tipo:"fijo", categoria:"SUELDOS", monto: total, detalle: desc, local_id: emp.local_id, cuenta:"Caja Chica" }]);
            await db.from("rrhh_pagos_especiales").insert([{ empleado_id: emp.id, tipo:"liquidacion_final", monto: total, gasto_id: gastoId, pagado_por: user?.id }]);
            await db.from("rrhh_empleados").update({ activo: false, fecha_egreso: liqFinalForm.fecha_egreso, motivo_baja: liqFinalForm.motivo, vacaciones_dias_acumulados: 0, aguinaldo_acumulado: 0 }).eq("id", emp.id);
            setLiqFinalModal(false);
            showToast("Liquidación final procesada");
            loadAll();
          };

          return (
            <div className="overlay" onClick={() => setLiqFinalModal(false)}>
              <div className="modal" style={{width:580}} onClick={e => e.stopPropagation()}>
                <div className="modal-hd"><div className="modal-title">Liquidación Final — {emp.apellido}, {emp.nombre}</div><button className="close-btn" onClick={() => setLiqFinalModal(false)}>✕</button></div>
                <div className="modal-body">
                  <div className="form2" style={{marginBottom:16}}>
                    <div className="field"><label>Fecha de egreso</label><input type="date" value={liqFinalForm.fecha_egreso} onChange={e => setLiqFinalForm({...liqFinalForm, fecha_egreso:e.target.value})} /></div>
                    <div className="field"><label>Motivo</label>
                      <select value={liqFinalForm.motivo} onChange={e => setLiqFinalForm({...liqFinalForm, motivo:e.target.value})}>
                        <option value="Renuncia">Renuncia</option><option value="Despido sin causa">Despido sin causa</option><option value="Despido con causa">Despido con causa</option><option value="Acuerdo mutuo">Acuerdo mutuo</option>
                      </select></div>
                  </div>
                  <div style={{background:"var(--s2)",borderRadius:"var(--r)",padding:16}}>
                    <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginBottom:12}}>Conceptos</div>
                    {[
                      ["Proporcional mes", proporcionalMes],
                      ["Vacaciones (" + vacDias.toFixed(1) + " días)", vacMonto],
                      ["SAC proporcional", sacProp],
                      ...(esDespidoSinCausa ? [
                        ["Indemnización (" + antAnios + " año" + (antAnios > 1 ? "s" : "") + ")", indemnizacion],
                        ["Preaviso", preaviso],
                        ["Integración mes despido", integracion],
                      ] : []),
                    ].map(([label, monto], i) => (
                      <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid var(--bd)",fontSize:12}}>
                        <span>{label}</span><span className="num" style={{color:"var(--acc)"}}>{fmt_$(monto as number)}</span>
                      </div>
                    ))}
                    <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0",fontSize:14,fontWeight:700}}>
                      <span>TOTAL</span><span className="num" style={{color:"var(--success)",fontSize:18}}>{fmt_$(total)}</span>
                    </div>
                  </div>
                </div>
                <div className="modal-ft">
                  <button className="btn btn-sec" onClick={() => setLiqFinalModal(false)}>Cancelar</button>
                  <button className="btn btn-danger" onClick={confirmarLiqFinal}>Confirmar y pagar</button>
                </div>
              </div>
            </div>
          );
        })()}
      </>)}

      {/* ═══ MOVIMIENTOS ═══════════════════════════════════════════════════ */}
      {tab === "movimientos" && (<>
        {movMeses.length === 0 ? <div className="empty">Sin movimientos registrados</div> : movMeses.map(nov => {
          const liqArr = Array.isArray(nov.rrhh_liquidaciones) ? nov.rrhh_liquidaciones : [];
          const liq = liqArr[0];
          const key = `${nov.anio}-${nov.mes}`;
          const isExp = expanded === key;
          const pagado = liq?.estado === "pagado";
          const puedePagar = esDueno && nov.estado === "confirmado" && liq && !pagado;

          return (
            <div key={key} className="panel" style={{marginBottom:8}}>
              <div className="panel-hd" style={{cursor:"pointer"}} onClick={() => setExpanded(isExp ? null : key)}>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <span className="panel-title">{MESES[nov.mes]} {nov.anio}</span>
                  <span className={`badge ${nov.estado === "confirmado" ? (pagado ? "b-success" : "b-warn") : "b-muted"}`}>
                    {nov.estado === "confirmado" ? (pagado ? "Pagado" : "Pendiente") : "Borrador"}
                  </span>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  {liq && <span className="num" style={{color: pagado ? "var(--success)" : "var(--acc)"}}>{fmt_$(liq.total_a_pagar)}</span>}
                  <span style={{color:"var(--muted2)"}}>{isExp ? "▲" : "▼"}</span>
                </div>
              </div>
              {isExp && (
                <div style={{padding:16}}>
                  <div className="grid3" style={{marginBottom:12}}>
                    <div><span style={{fontSize:9,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1}}>Inasistencias</span><div>{nov.inasistencias || 0}</div></div>
                    <div><span style={{fontSize:9,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1}}>Presentismo</span><div>{nov.presentismo}</div></div>
                    <div><span style={{fontSize:9,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1}}>Hs Extras</span><div>{nov.horas_extras || 0}</div></div>
                  </div>
                  <div className="grid3" style={{marginBottom:12}}>
                    <div><span style={{fontSize:9,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1}}>Dobles</span><div>{nov.dobles || 0}</div></div>
                    <div><span style={{fontSize:9,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1}}>Feriados</span><div>{nov.feriados || 0}</div></div>
                    <div><span style={{fontSize:9,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1}}>Adelantos</span><div>{fmt_$(nov.adelantos || 0)}</div></div>
                  </div>
                  {nov.observaciones && <div style={{fontSize:11,color:"var(--muted2)",marginBottom:12}}>Obs: {nov.observaciones}</div>}

                  {liq && (
                    <div style={{background:"var(--s2)",borderRadius:"var(--r)",padding:12,marginBottom:12}}>
                      <div style={{display:"flex",flexWrap:"wrap",gap:16,fontSize:11}}>
                        <div>Base: <strong>{fmt_$(liq.sueldo_base)}</strong></div>
                        {liq.descuento_ausencias > 0 && <div style={{color:"var(--danger)"}}>-Ausencias: {fmt_$(liq.descuento_ausencias)}</div>}
                        {liq.total_horas_extras > 0 && <div>+HE: {fmt_$(liq.total_horas_extras)}</div>}
                        {liq.total_dobles > 0 && <div>+Dobles: {fmt_$(liq.total_dobles)}</div>}
                        {liq.total_feriados > 0 && <div>+Feriados: {fmt_$(liq.total_feriados)}</div>}
                        {liq.monto_presentismo > 0 && <div style={{color:"var(--success)"}}>+Present.: {fmt_$(liq.monto_presentismo)}</div>}
                        {liq.adelantos > 0 && <div style={{color:"var(--warn)"}}>-Adelantos: {fmt_$(liq.adelantos)}</div>}
                        {liq.pagos_realizados > 0 && <div style={{color:"var(--warn)"}}>-Pagos: {fmt_$(liq.pagos_realizados)}</div>}
                      </div>
                      <div style={{marginTop:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div>
                          <span className="num" style={{fontSize:16,color:"var(--success)"}}>{fmt_$(liq.total_a_pagar)}</span>
                          {liq.efectivo > 0 && <span style={{fontSize:10,color:"var(--muted2)",marginLeft:8}}>Efvo: {fmt_$(liq.efectivo)}</span>}
                          {liq.transferencia > 0 && <span style={{fontSize:10,color:"var(--info)",marginLeft:8}}>Transf: {fmt_$(liq.transferencia)}</span>}
                        </div>
                        {/* Pagos se gestionan desde el tab Pagos de RRHH */}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </>)}

      {/* ═══ VACACIONES Y AGUINALDO ════════════════════════════════════════ */}
      {tab === "vacagu" && (<>
        <div className="grid2" style={{marginBottom:20}}>
          {/* Vacaciones */}
          <div className="panel">
            <div className="panel-hd"><span className="panel-title">Vacaciones</span></div>
            <div style={{padding:16}}>
              <div style={{marginBottom:12}}>
                <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Días disponibles</div>
                <div className="num" style={{fontSize:20,color:"var(--acc)"}}>{vacAcumuladas.toFixed(1)} días</div>
                <div style={{fontSize:11,color:"var(--muted2)",marginTop:2}}>Equivale a {fmt_$(vacAcumuladas * valorDia)}</div>
                {vacTomadas > 0 && <div style={{fontSize:10,color:"var(--muted2)",marginTop:2}}>Tomadas: {vacTomadas.toFixed(1)} días</div>}
              </div>
              <div style={{fontSize:10,color:"var(--muted2)",marginBottom:12}}>
                Corresponde: {diasVacAnuales} días/año ({diasVacPorMes.toFixed(2)} días/mes) · Antigüedad: {Math.floor(antiguedadAnios)} años
              </div>
              {esDueno && vacAcumuladas > 0 && (
                <button className="btn btn-acc btn-sm" onClick={() => { setVacDias(String(vacAcumuladas.toFixed(1))); setVacModal(true); }}>Pagar vacaciones</button>
              )}
            </div>
          </div>

          {/* Aguinaldo */}
          <div className="panel">
            <div className="panel-hd"><span className="panel-title">Aguinaldo</span></div>
            <div style={{padding:16}}>
              <div style={{marginBottom:12}}>
                <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Acumulado proporcional ({mesesEnSemestre} {mesesEnSemestre === 1 ? "mes" : "meses"} del semestre)</div>
                <div className="num" style={{fontSize:20,color:"var(--acc)"}}>{fmt_$(sacAcumulado)}</div>
                <div style={{fontSize:11,color:"var(--muted2)",marginTop:4}}>Teórico semestre completo: {fmt_$(sacTeorico)}</div>
                <div style={{fontSize:10,color:"var(--muted2)",marginTop:2}}>SAC = mejor sueldo del semestre / 2 · Pago en {mesActual <= 6 ? "junio" : "diciembre"}</div>
              </div>
              {esDueno && sacAcumulado > 0 && (
                <button className="btn btn-acc btn-sm" onClick={() => setAguModal(true)}>Pagar aguinaldo</button>
              )}
            </div>
          </div>
        </div>

        {/* Historial pagos especiales */}
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">Historial de pagos especiales</span></div>
          {pagosEsp.length === 0 ? <div className="empty">Sin pagos registrados</div> : (
            <table><thead><tr><th>Fecha</th><th>Tipo</th><th>Días</th><th style={{textAlign:"right"}}>Monto</th></tr></thead>
            <tbody>{pagosEsp.map(p => (
              <tr key={p.id}>
                <td className="mono">{fmt_d(p.pagado_at?.split("T")[0])}</td>
                <td><span className={`badge ${p.tipo === "vacaciones" ? "b-info" : "b-warn"}`}>{p.tipo}</span></td>
                <td>{p.dias || "—"}</td>
                <td style={{textAlign:"right"}}><span className="num kpi-acc">{fmt_$(p.monto)}</span></td>
              </tr>
            ))}</tbody></table>
          )}
        </div>

        {/* Modal vacaciones */}
        {vacModal && (
          <div className="overlay" onClick={() => setVacModal(false)}>
            <div className="modal" style={{width:420}} onClick={e => e.stopPropagation()}>
              <div className="modal-hd"><div className="modal-title">Pagar vacaciones</div><button className="close-btn" onClick={() => setVacModal(false)}>✕</button></div>
              <div className="modal-body">
                <div className="alert alert-info">Disponibles: {vacAcumuladas.toFixed(1)} días · {fmt_$(vacAcumuladas * valorDia)}</div>
                <div className="field"><label>Días a pagar</label><input type="number" value={vacDias} onChange={e => setVacDias(e.target.value)} /></div>
                {vacDias && <div style={{padding:8,fontSize:12}}>Monto: <strong style={{color:"var(--acc)"}}>{fmt_$(parseFloat(vacDias) * valorDia)}</strong></div>}
              </div>
              <div className="modal-ft"><button className="btn btn-sec" onClick={() => setVacModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={pagarVacaciones}>Confirmar pago</button></div>
            </div>
          </div>
        )}

        {/* Modal aguinaldo */}
        {aguModal && (
          <div className="overlay" onClick={() => setAguModal(false)}>
            <div className="modal" style={{width:420}} onClick={e => e.stopPropagation()}>
              <div className="modal-hd"><div className="modal-title">Pagar aguinaldo</div><button className="close-btn" onClick={() => setAguModal(false)}>✕</button></div>
              <div className="modal-body">
                <div className="alert alert-info">Monto acumulado proporcional: {fmt_$(sacAcumulado)}</div>
                <div style={{fontSize:11,color:"var(--muted2)",padding:"4px 0"}}>Teórico semestre completo: {fmt_$(sacTeorico)}</div>
              </div>
              <div className="modal-ft"><button className="btn btn-sec" onClick={() => setAguModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={pagarAguinaldo}>Confirmar pago</button></div>
            </div>
          </div>
        )}
      </>)}

      {/* ═══ DOCUMENTOS ═══════════════════════════════════════════════════ */}
      {tab === "documentos" && (<>
        <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
          {esDueno && <button className="btn btn-acc btn-sm" onClick={() => setDocModal(true)}>+ Subir documento</button>}
        </div>
        <div className="panel">
          {docs.length === 0 ? <div className="empty">Sin documentos</div> : (
            <table><thead><tr><th>Nombre</th><th>Tipo</th><th>Período</th><th>Fecha</th><th></th></tr></thead>
            <tbody>{docs.map(d => (
              <tr key={d.id}>
                <td style={{fontWeight:500,fontSize:11}}>{d.nombre_archivo}</td>
                <td><span className="badge b-info">{DOC_TIPOS.find(t => t.value === d.tipo)?.label || d.tipo}</span></td>
                <td style={{fontSize:11,color:"var(--muted2)"}}>{d.mes && d.anio ? `${MESES[d.mes]} ${d.anio}` : "—"}</td>
                <td className="mono" style={{fontSize:11}}>{fmt_d(d.subido_at?.split("T")[0])}</td>
                <td>
                  <div style={{display:"flex",gap:4}}>
                    <button className="btn btn-ghost btn-sm" onClick={() => verDoc(d)}>Ver</button>
                    {esDueno && <button className="btn btn-danger btn-sm" onClick={() => eliminarDoc(d)}>X</button>}
                  </div>
                </td>
              </tr>
            ))}</tbody></table>
          )}
        </div>

        {docModal && (
          <div className="overlay" onClick={() => setDocModal(false)}>
            <div className="modal" style={{width:480}} onClick={e => e.stopPropagation()}>
              <div className="modal-hd"><div className="modal-title">Subir documento</div><button className="close-btn" onClick={() => setDocModal(false)}>✕</button></div>
              <div className="modal-body">
                <div className="field"><label>Tipo de documento</label>
                  <select value={docForm.tipo} onChange={e => setDocForm({...docForm, tipo:e.target.value})}>
                    {DOC_TIPOS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select></div>
                <div className="form2">
                  <div className="field"><label>Mes (opcional)</label>
                    <select value={docForm.mes} onChange={e => setDocForm({...docForm, mes:e.target.value})}>
                      <option value="">—</option>{MESES.slice(1).map((m,i) => <option key={i+1} value={i+1}>{m}</option>)}
                    </select></div>
                  <div className="field"><label>Año (opcional)</label>
                    <input type="number" value={docForm.anio} onChange={e => setDocForm({...docForm, anio:e.target.value})} placeholder={String(today.getFullYear())} /></div>
                </div>
                <div className="field"><label>Archivo</label>
                  <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                    onChange={e => e.target.files?.[0] && subirDoc(e.target.files[0])}
                    style={{background:"var(--bg)",border:"1px solid var(--bd)",padding:8,borderRadius:"var(--r)",width:"100%",color:"var(--txt)",fontFamily:"'DM Mono',monospace",fontSize:12}} />
                </div>
                {uploading && <div className="loading">Subiendo...</div>}
              </div>
              <div className="modal-ft"><button className="btn btn-sec" onClick={() => setDocModal(false)}>Cerrar</button></div>
            </div>
          </div>
        )}
      </>)}
    </div>
  );
}
