import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";
import {
  diasVacacionesPorAnio,
  calcularVacaciones,
  calcularSACProporcional,
  calcularSACTeorico,
  calcularLiquidacionFinal,
} from "../lib/calculos/rrhh";

const MESES = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const DOC_TIPOS = [
  { value:"alta_temprana", label:"Alta temprana" },
  { value:"dni", label:"DNI" },
  { value:"recibo_sueldo", label:"Recibo de sueldo" },
  { value:"baja", label:"Baja" },
  { value:"contrato", label:"Contrato" },
  { value:"otro", label:"Otro" },
];

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
  const [vacMonto, setVacMonto] = useState("");
  const [aguModal, setAguModal] = useState(false);
  const [aguMonto, setAguMonto] = useState("");

  // Documentos
  const [docs, setDocs] = useState<any[]>([]);
  const [docModal, setDocModal] = useState(false);
  const [docForm, setDocForm] = useState({ tipo:"otro", mes:"", anio:"" });
  const [uploading, setUploading] = useState(false);

  // Liquidación final
  const [liqFinalModal, setLiqFinalModal] = useState(false);
  const [liqFinalForm, setLiqFinalForm] = useState({ fecha_egreso: toISO(today), motivo: "Renuncia" });
  const [liqFinalData, setLiqFinalData] = useState<any>(null);
  const [liqFinalCuenta, setLiqFinalCuenta] = useState("Caja Efectivo");
  const [liqFinalOverrides, setLiqFinalOverrides] = useState<Record<string, string>>({});
  const [liqFinalLoading, setLiqFinalLoading] = useState(false);

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

  // Recalcular liquidación final cuando cambia fecha/motivo o abre el modal
  useEffect(() => {
    if (!liqFinalModal || !emp) return;
    const vacAcum = calcularVacaciones(emp.fecha_inicio, vacTomadas);
    const lf = calcularLiquidacionFinal({
      sueldo_mensual: Number(emp.sueldo_mensual),
      fecha_inicio: emp.fecha_inicio,
      fecha_egreso: liqFinalForm.fecha_egreso,
      vacaciones_acumuladas: vacAcum,
      motivo: liqFinalForm.motivo as any,
    });
    setLiqFinalData(lf);
  }, [liqFinalModal, liqFinalForm.fecha_egreso, liqFinalForm.motivo, emp?.sueldo_mensual, emp?.fecha_inicio, vacTomadas]);

  // Reset overrides al cambiar motivo
  useEffect(() => { setLiqFinalOverrides({}); }, [liqFinalForm.motivo]);

  if (loading || !emp) return <div className="loading">Cargando legajo...</div>;

  const localNombre = locales.find(l => l.id === emp.local_id)?.nombre || "—";
  const valorDia = emp.sueldo_mensual / 30;
  const valorDiaVacacional = emp.sueldo_mensual / 25; // LCT Art 155

  // Antigüedad
  const fechaInicio = emp.fecha_inicio ? new Date(emp.fecha_inicio + "T12:00:00") : null;
  const antiguedadMs = fechaInicio ? Date.now() - fechaInicio.getTime() : 0;
  const antiguedadAnios = antiguedadMs / (365.25 * 24 * 60 * 60 * 1000);
  const diasVacAnuales = diasVacacionesPorAnio(Math.floor(antiguedadAnios));
  const diasVacPorMes = diasVacAnuales / 12;
  const vacAcumuladas = calcularVacaciones(emp.fecha_inicio, vacTomadas);

  // SAC teórico
  const mesActual = new Date().getMonth() + 1;
  const mesesEnSemestre = mesActual <= 6 ? mesActual : mesActual - 6;
  const sueldoNum = parseFloat(String(emp.sueldo_mensual || 0)) || 0;
  const sacAcumulado = calcularSACProporcional(sueldoNum, mesActual);
  const sacTeorico = calcularSACTeorico(sueldoNum);

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

  // ─── ACCIONES: VACACIONES ──────────────────────────────────────────────────
  const plusVacacional = vacAcumuladas * valorDiaVacacional;

  const pagarVacaciones = async () => {
    const dias = parseFloat(vacDias) || vacAcumuladas;
    const monto = parseFloat(vacMonto) || plusVacacional;
    if (dias <= 0 || monto <= 0) return;
    const desc = `Vacaciones ${emp.apellido} ${emp.nombre}`;
    const cuenta = "Caja Chica";

    await db.from("rrhh_pagos_especiales").insert([{
      empleado_id: emp.id, tipo: "vacaciones", monto, dias,
      gasto_id: null, pagado_por: user?.id,
    }]);
    if (emp.local_id) {
      const { data: caja } = await db.from("saldos_caja").select("saldo").eq("cuenta", cuenta).eq("local_id", emp.local_id).maybeSingle();
      if (caja) await db.from("saldos_caja").update({ saldo: (caja.saldo || 0) - monto }).eq("cuenta", cuenta).eq("local_id", emp.local_id);
    }
    await db.from("movimientos").insert([{
      id: genId("MOV"), fecha: toISO(today), cuenta,
      tipo: "Pago Vacaciones", cat: "SUELDOS", importe: -monto, detalle: desc,
      local_id: emp.local_id,
    }]);
    await db.from("rrhh_empleados").update({ vacaciones_dias_acumulados: 0 }).eq("id", emp.id);

    setVacModal(false); setVacDias(""); setVacMonto("");
    showToast("Vacaciones pagadas");
    loadAll();
  };

  // ─── ACCIONES: AGUINALDO ───────────────────────────────────────────────────
  const pagarAguinaldo = async () => {
    const monto = parseFloat(aguMonto) || sacAcumulado;
    if (monto <= 0) return;
    const desc = `Aguinaldo ${emp.apellido} ${emp.nombre}`;
    const cuenta = "Caja Chica";

    await db.from("rrhh_pagos_especiales").insert([{
      empleado_id: emp.id, tipo: "aguinaldo", monto,
      gasto_id: null, pagado_por: user?.id,
    }]);
    if (emp.local_id) {
      const { data: caja } = await db.from("saldos_caja").select("saldo").eq("cuenta", cuenta).eq("local_id", emp.local_id).maybeSingle();
      if (caja) await db.from("saldos_caja").update({ saldo: (caja.saldo || 0) - monto }).eq("cuenta", cuenta).eq("local_id", emp.local_id);
    }
    await db.from("movimientos").insert([{
      id: genId("MOV"), fecha: toISO(today), cuenta,
      tipo: "Pago Aguinaldo", cat: "SUELDOS", importe: -monto, detalle: desc,
      local_id: emp.local_id,
    }]);
    await db.from("rrhh_empleados").update({ aguinaldo_acumulado: 0 }).eq("id", emp.id);

    setAguModal(false); setAguMonto("");
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
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:17,fontWeight:500,lineHeight:1,color:"#fff"}}>{emp.apellido}, {emp.nombre}</div>
          <div style={{fontSize:11,color:"var(--muted2)",marginTop:4}}>{emp.puesto} · {localNombre} · {emp.activo ? "Activo" : "Inactivo"}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:9,letterSpacing:2,textTransform:"uppercase",color:"var(--muted)"}}>Sueldo mensual</div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:17,fontWeight:500,color:"var(--acc)"}}>{fmt_$(emp.sueldo_mensual)}</div>
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
        <div className="grid2" style={{marginBottom:16}}>
          <div className="kpi"><div className="kpi-label">CBU / Alias</div><div style={{fontSize:13}}>{emp.alias_mp || "—"}</div></div>
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
          const esDespidoSinCausa = liqFinalForm.motivo === "Despido sin causa";
          const esAcuerdoMutuo = liqFinalForm.motivo === "Acuerdo mutuo";
          const antAnios = Math.max(1, Math.floor(antiguedadAnios));

          const conceptos: [string, string][] = [
            ["proporcional_mes", "Proporcional mes"],
            ["vacaciones_dinero", "Vacaciones (" + vacAcumuladas.toFixed(1) + " días)"],
            ["sac_proporcional", "SAC proporcional"],
            ...(esDespidoSinCausa ? ([
              ["indemnizacion", "Indemnización (" + antAnios + " año" + (antAnios > 1 ? "s" : "") + ")"],
              ["preaviso", "Preaviso"],
              ["integracion_mes", "Integración mes despido"],
            ] as [string, string][]) : []),
          ];

          const getConceptoMonto = (key: string, calculado: number) => {
            if (esAcuerdoMutuo && liqFinalOverrides[key] !== undefined) {
              return parseFloat(liqFinalOverrides[key]) || 0;
            }
            return calculado;
          };

          const total = conceptos.reduce((s, [k]) => {
            const calc = liqFinalData?.[k] || 0;
            return s + getConceptoMonto(k, calc);
          }, 0);

          const confirmarLiqFinal = async () => {
            if (!liqFinalData || liqFinalLoading) return;
            setLiqFinalLoading(true);
            try {
              const { data: existing } = await db.from("rrhh_pagos_especiales")
                .select("id").eq("empleado_id", emp.id).eq("tipo", "liquidacion_final");
              if (existing && existing.length > 0) {
                alert("Ya existe una liquidación final para este empleado");
                return;
              }
              const desc = `Liquidación final ${emp.apellido} ${emp.nombre}`;

              await db.from("rrhh_pagos_especiales").insert([{
                empleado_id: emp.id, tipo: "liquidacion_final", monto: total,
                gasto_id: null, pagado_por: user?.id,
              }]);
              if (emp.local_id) {
                const { data: caja } = await db.from("saldos_caja").select("saldo").eq("cuenta", liqFinalCuenta).eq("local_id", emp.local_id).maybeSingle();
                if (caja) await db.from("saldos_caja").update({ saldo: (caja.saldo || 0) - total }).eq("cuenta", liqFinalCuenta).eq("local_id", emp.local_id);
              }
              await db.from("movimientos").insert([{
                id: genId("MOV"), fecha: toISO(today), cuenta: liqFinalCuenta,
                tipo: "Liquidación Final", cat: "SUELDOS", importe: -total, detalle: desc,
                local_id: emp.local_id,
              }]);
              await db.from("rrhh_empleados").update({
                activo: false, fecha_egreso: liqFinalForm.fecha_egreso, motivo_baja: liqFinalForm.motivo,
                vacaciones_dias_acumulados: 0, aguinaldo_acumulado: 0,
              }).eq("id", emp.id);
              setLiqFinalModal(false);
              showToast("Liquidación final procesada");
              loadAll();
            } finally {
              setLiqFinalLoading(false);
            }
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
                    <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginBottom:12}}>
                      Conceptos{esAcuerdoMutuo && <span style={{color:"var(--warn)",marginLeft:8}}>(editables)</span>}
                    </div>
                    {conceptos.map(([key, label]) => {
                      const calc = liqFinalData?.[key] || 0;
                      const monto = getConceptoMonto(key, calc);
                      return (
                        <div key={key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid var(--bd)",fontSize:12}}>
                          <span>{label}</span>
                          {esAcuerdoMutuo ? (
                            <input
                              type="number"
                              value={liqFinalOverrides[key] ?? String(calc)}
                              onChange={e => setLiqFinalOverrides(prev => ({...prev, [key]: e.target.value}))}
                              style={{width:130,background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--acc)",padding:"3px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,textAlign:"right",borderRadius:"var(--r)"}}
                            />
                          ) : (
                            <span className="num" style={{color:"var(--acc)"}}>{fmt_$(monto)}</span>
                          )}
                        </div>
                      );
                    })}
                    <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0",fontSize:13,fontWeight:500}}>
                      <span>TOTAL</span><span className="num" style={{color:"var(--success)",fontSize:15,fontWeight:500}}>{fmt_$(total)}</span>
                    </div>
                  </div>
                  <div className="field" style={{marginTop:12}}><label>Cuenta de egreso</label>
                    <select value={liqFinalCuenta} onChange={e => setLiqFinalCuenta(e.target.value)}>
                      {["Caja Efectivo","Caja Chica","Caja Mayor","MercadoPago","Banco"].map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
                <div className="modal-ft">
                  <button className="btn btn-sec" onClick={() => setLiqFinalModal(false)}>Cancelar</button>
                  <button className="btn btn-danger" disabled={liqFinalLoading} onClick={confirmarLiqFinal}>{liqFinalLoading ? "Procesando..." : "Confirmar y pagar"}</button>
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
                          <span className="num" style={{fontSize:14,color:"var(--success)"}}>{fmt_$(liq.total_a_pagar)}</span>
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
                <div className="num" style={{fontSize:17,fontWeight:500,color:"var(--acc)"}}>{vacAcumuladas.toFixed(1)} días</div>
                <div style={{fontSize:11,color:"var(--muted2)",marginTop:2}}>Equivale a {fmt_$(vacAcumuladas * valorDia)}</div>
                {vacTomadas > 0 && <div style={{fontSize:10,color:"var(--muted2)",marginTop:2}}>Tomadas: {vacTomadas.toFixed(1)} días</div>}
              </div>
              <div style={{fontSize:10,color:"var(--muted2)",marginBottom:12}}>
                Corresponde: {diasVacAnuales} días/año ({diasVacPorMes.toFixed(2)} días/mes) · Antigüedad: {Math.floor(antiguedadAnios)} años
              </div>
              {esDueno && vacAcumuladas > 0 && (
                <button className="btn btn-acc btn-sm" onClick={() => { setVacDias(String(vacAcumuladas.toFixed(1))); setVacMonto(""); setVacModal(true); }}>Pagar vacaciones</button>
              )}
            </div>
          </div>

          {/* Aguinaldo */}
          <div className="panel">
            <div className="panel-hd"><span className="panel-title">Aguinaldo</span></div>
            <div style={{padding:16}}>
              <div style={{marginBottom:12}}>
                <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Acumulado proporcional ({mesesEnSemestre} {mesesEnSemestre === 1 ? "mes" : "meses"} del semestre)</div>
                <div className="num" style={{fontSize:17,fontWeight:500,color:"var(--acc)"}}>{fmt_$(sacAcumulado)}</div>
                <div style={{fontSize:11,color:"var(--muted2)",marginTop:4}}>Teórico semestre completo: {fmt_$(sacTeorico)}</div>
                <div style={{fontSize:10,color:"var(--muted2)",marginTop:2}}>SAC = mejor sueldo del semestre / 2 · Pago en {mesActual <= 6 ? "junio" : "diciembre"}</div>
              </div>
              {esDueno && sacAcumulado > 0 && (
                <button className="btn btn-acc btn-sm" onClick={() => { setAguMonto(""); setAguModal(true); }}>Pagar aguinaldo</button>
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
            <div className="modal" style={{width:440}} onClick={e => e.stopPropagation()}>
              <div className="modal-hd"><div className="modal-title">Pagar vacaciones</div><button className="close-btn" onClick={() => setVacModal(false)}>✕</button></div>
              <div className="modal-body">
                <div className="field"><label>Días a pagar</label>
                  <input type="number" value={vacDias} onChange={e => setVacDias(e.target.value)} placeholder={vacAcumuladas.toFixed(1)} />
                </div>
                <div className="field"><label>Monto $</label>
                  <input type="number" value={vacMonto} onChange={e => setVacMonto(e.target.value)} placeholder={fmt_$(plusVacacional)} />
                  <div style={{fontSize:10,color:"var(--muted2)",marginTop:4}}>
                    Plus vacacional recomendado: <strong style={{color:"var(--acc)"}}>{fmt_$(plusVacacional)}</strong> ({vacAcumuladas.toFixed(1)} días × sueldo/25)
                  </div>
                </div>
              </div>
              <div className="modal-ft">
                <button className="btn btn-sec" onClick={() => setVacModal(false)}>Cancelar</button>
                <button className="btn btn-acc" onClick={pagarVacaciones}>Confirmar pago</button>
              </div>
            </div>
          </div>
        )}

        {/* Modal aguinaldo */}
        {aguModal && (
          <div className="overlay" onClick={() => setAguModal(false)}>
            <div className="modal" style={{width:440}} onClick={e => e.stopPropagation()}>
              <div className="modal-hd"><div className="modal-title">Pagar aguinaldo</div><button className="close-btn" onClick={() => setAguModal(false)}>✕</button></div>
              <div className="modal-body">
                <div className="field"><label>Monto $</label>
                  <input type="number" value={aguMonto} onChange={e => setAguMonto(e.target.value)} placeholder={fmt_$(sacAcumulado)} />
                  <div style={{fontSize:10,color:"var(--muted2)",marginTop:4}}>
                    Acumulado proporcional: <strong style={{color:"var(--acc)"}}>{fmt_$(sacAcumulado)}</strong> · Teórico semestre: {fmt_$(sacTeorico)}
                  </div>
                </div>
              </div>
              <div className="modal-ft">
                <button className="btn btn-sec" onClick={() => setAguModal(false)}>Cancelar</button>
                <button className="btn btn-acc" onClick={pagarAguinaldo}>Confirmar pago</button>
              </div>
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
