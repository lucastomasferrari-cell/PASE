import { useState, useEffect, useRef } from "react";
import { db } from "../lib/supabase";
import { localesVisibles } from "../lib/auth";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";
import {
  calcularVacaciones,
  calcularSACProporcional,
  calcularTotalLiquidacion,
} from "../lib/calculos/rrhh";
import RRHHLegajo from "./RRHHLegajo";

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function calcLiquidacion(emp: any, nov: any, valorDoble: number) {
  const result = calcularTotalLiquidacion({
    sueldo_mensual: emp.sueldo_mensual,
    modo_pago: emp.modo_pago,
    inasistencias: nov.inasistencias || 0,
    horas_extras: nov.horas_extras || 0,
    dobles: nov.dobles || 0,
    valor_doble: valorDoble,
    feriados: nov.feriados || 0,
    vacaciones_dias: nov.vacaciones_dias || 0,
    presentismo_mantiene: nov.presentismo === "MANTIENE",
    adelantos: nov.adelantos || 0,
    pagos_dobles_realizados: nov.pagos_dobles_realizados || 0,
  });
  return {
    ...result,
    efectivo: emp.alias_mp ? 0 : Math.max(result.total_a_pagar, 0),
    transferencia: emp.alias_mp ? Math.max(result.total_a_pagar, 0) : 0,
  };
}

const MESES_NOMBRE = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const MESES_SEL = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const PRESENTISMO_OPTS = [
  { value:"MANTIENE", label:"Mantiene" }, { value:"PIERDE", label:"Pierde" },
  { value:"PIERDE_LLEGADAS", label:"Pierde (lleg.)" }, { value:"INICIO_PARCIAL", label:"Inicio parc." },
];

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function RRHH({ user, locales, localActivo }) {
  const [tab, setTab] = useState("dashboard");
  const [legajoId, setLegajoId] = useState<string | null>(null);
  const [cfgModal, setCfgModal] = useState(false);
  const [toast, setToast] = useState("");
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 3000); };

  const visLocs = localesVisibles(user);
  const locsDisp = visLocs === null ? locales : locales.filter(l => visLocs.includes(l.id));
  const esEnc = user?.rol === "encargado";
  const esDueno = user?.rol === "dueno" || user?.rol === "admin";
  const defaultLocal = localActivo || (locsDisp.length === 1 ? locsDisp[0]?.id : (esEnc && locsDisp.length ? locsDisp[0].id : ""));

  // ─── SHARED STATE ──────────────────────────────────────────────────────────
  const [allEmps, setAllEmps] = useState<any[]>([]);
  const [valoresDoble, setValoresDoble] = useState<any[]>([]);
  const [empSearch, setEmpSearch] = useState("");
  const [vacTomadas, setVacTomadas] = useState<Record<string, number>>({});
  const [empFiltLocal, setEmpFiltLocal] = useState(defaultLocal);
  const [empModal, setEmpModal] = useState<any>(null);
  const empEmpty = { local_id:"", apellido:"", nombre:"", cuil:"", puesto:"", modo_pago:"MENSUAL", sueldo_mensual:"", alias_mp:"", fecha_inicio:"", activo:true };
  const [empForm, setEmpForm] = useState(empEmpty);

  // Novedades
  const [novMes, setNovMes] = useState(today.getMonth() + 1);
  const [novAnio, setNovAnio] = useState(today.getFullYear());
  const [novLocal, setNovLocal] = useState(defaultLocal);
  const [novEmps, setNovEmps] = useState<any[]>([]);
  const [novMap, setNovMap] = useState<Record<string, any>>({});
  const [novLoading, setNovLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const saveTimers = useRef<Record<string, any>>({});

  // Pagos
  const [pagoMes, setPagoMes] = useState(today.getMonth() + 1);
  const [pagoAnio, setPagoAnio] = useState(today.getFullYear());
  const [pagoLocal, setPagoLocal] = useState(defaultLocal);
  const [pagoData, setPagoData] = useState<any[]>([]);
  const [pagoLoading, setPagoLoading] = useState(false);
  const [pagando, setPagando] = useState(false);

  // Dashboard
  const [dashLoading, setDashLoading] = useState(true);
  const [dashStats, setDashStats] = useState<any>({});

  // Config
  const [cfgEdit, setCfgEdit] = useState<any>(null);

  // ─── LOAD FUNCTIONS ────────────────────────────────────────────────────────
  const loadValoresDoble = async () => {
    const { data } = await db.from("rrhh_valores_doble").select("*").order("puesto");
    setValoresDoble(data || []);
  };

  const loadEmpleados = async () => {
    const { data } = await db.from("rrhh_empleados").select("*").order("apellido");
    setAllEmps(data || []);
    // Cargar días de vacaciones tomadas (novedades confirmadas)
    const empIds = (data || []).map(e => e.id);
    if (empIds.length) {
      const { data: novs } = await db.from("rrhh_novedades").select("empleado_id, vacaciones_dias").eq("estado", "confirmado").in("empleado_id", empIds).gt("vacaciones_dias", 0);
      const map: Record<string, number> = {};
      (novs || []).forEach(n => { map[n.empleado_id] = (map[n.empleado_id] || 0) + Number(n.vacaciones_dias || 0); });
      setVacTomadas(map);
    }
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

  const loadPagos = async () => {
    if (!pagoLocal) return;
    setPagoLoading(true);
    const { data: emps } = await db.from("rrhh_empleados").select("*").eq("local_id", parseInt(pagoLocal)).eq("activo", true).order("apellido");
    const empIds = (emps || []).map(e => e.id);
    let novs: any[] = [];
    if (empIds.length) {
      const { data } = await db.from("rrhh_novedades").select("*, rrhh_liquidaciones(*)").eq("mes", pagoMes).eq("anio", pagoAnio).eq("estado", "confirmado").in("empleado_id", empIds);
      novs = data || [];
    }
    const merged = (emps || []).map(emp => {
      const nov = novs.find(n => n.empleado_id === emp.id);
      let liq = nov ? (Array.isArray(nov.rrhh_liquidaciones) ? nov.rrhh_liquidaciones : [])[0] : null;
      // Si la novedad está confirmada pero no tiene liquidación, calcularla on-the-fly
      if (nov && !liq) {
        const vd = valoresDoble.find(v => v.puesto === emp.puesto)?.valor || 0;
        const calc = calcLiquidacion(emp, nov, vd);
        liq = { ...calc, estado: "pendiente", _novedadId: nov.id, _generated: true };
      }
      return { emp, nov, liq };
    }).filter(r => r.nov);
    setPagoData(merged);
    setPagoLoading(false);
  };

  const loadDashboard = async () => {
    setDashLoading(true);
    const { data: emps } = await db.from("rrhh_empleados").select("*").eq("activo", true);
    const activos = emps || [];
    const mes = today.getMonth() + 1;
    const anio = today.getFullYear();
    const empIds = activos.map(e => e.id);
    let novsMes: any[] = [];
    if (empIds.length) {
      const { data } = await db.from("rrhh_novedades").select("*, rrhh_liquidaciones(*)").eq("mes", mes).eq("anio", anio).in("empleado_id", empIds);
      novsMes = data || [];
    }
    const mensuales = activos.filter(e => e.modo_pago === "MENSUAL").length;
    const quincenales = activos.filter(e => e.modo_pago === "QUINCENAL").length;
    const semanales = activos.filter(e => e.modo_pago === "SEMANAL").length;
    const sinCuil = activos.filter(e => !e.cuil || e.cuil.trim() === "").length;
    const conNovedades = novsMes.length;
    const confirmadas = novsMes.filter(n => n.estado === "confirmado").length;
    const pagados = novsMes.filter(n => {
      const liq = (Array.isArray(n.rrhh_liquidaciones) ? n.rrhh_liquidaciones : [])[0];
      return liq?.estado === "pagado";
    }).length;
    // Estimado a pagar
    let estimado = 0;
    activos.forEach(emp => {
      const nov = novsMes.find(n => n.empleado_id === emp.id);
      if (nov && nov.estado === "confirmado") {
        const liq = (Array.isArray(nov.rrhh_liquidaciones) ? nov.rrhh_liquidaciones : [])[0];
        estimado += liq ? Number(liq.total_a_pagar || 0) : Number(emp.sueldo_mensual);
      } else {
        estimado += Number(emp.sueldo_mensual);
      }
    });
    const mesActual = today.getMonth() + 1;
    const totalSAC = activos.reduce((s, e) => {
      const sueldo = parseFloat(String(e.sueldo_mensual || 0)) || 0;
      return s + calcularSACProporcional(sueldo, mesActual);
    }, 0);
    // Próximo SAC
    const junio30 = new Date(anio, 5, 30);
    const dic31 = new Date(anio, 11, 31);
    const ahora = new Date();
    let proxSAC = junio30 > ahora ? junio30 : dic31;
    if (dic31 < ahora) proxSAC = new Date(anio + 1, 5, 30);
    const diasSAC = Math.max(0, Math.ceil((proxSAC.getTime() - ahora.getTime()) / 86400000));
    // Días hasta fin de mes
    const finMes = new Date(anio, mes, 0);
    const diasFinMes = Math.max(0, Math.ceil((finMes.getTime() - ahora.getTime()) / 86400000));

    setDashStats({
      total: activos.length, mensuales, quincenales, semanales, sinCuil,
      conNovedades, confirmadas, pagados, estimado, totalSAC,
      proxSAC: proxSAC.toLocaleDateString("es-AR"), diasSAC, diasFinMes,
      mes, anio,
    });
    setDashLoading(false);
  };

  useEffect(() => { loadValoresDoble(); loadEmpleados(); }, []);
  useEffect(() => { if (tab === "dashboard") loadDashboard(); }, [tab]);
  useEffect(() => { if (tab === "novedades" && novLocal) loadNovedades(); }, [tab, novLocal, novMes, novAnio]);
  useEffect(() => { if (tab === "pagos" && pagoLocal) loadPagos(); }, [tab, pagoLocal, pagoMes, pagoAnio]);

  // Autoseleccionar local para encargados con un solo local
  useEffect(() => {
    if (tab === "novedades" && !novLocal && locsDisp.length >= 1) {
      const localDefault = esEnc || locsDisp.length === 1
        ? String(locsDisp[0].id)
        : "";
      if (localDefault) setNovLocal(localDefault);
    }
  }, [tab, locsDisp.length, locsDisp[0]?.id]);
  useEffect(() => {
    if (tab === "pagos" && !pagoLocal && locsDisp.length >= 1) {
      const localDefault = esEnc || locsDisp.length === 1
        ? String(locsDisp[0].id)
        : "";
      if (localDefault) setPagoLocal(localDefault);
    }
  }, [tab, locsDisp.length, locsDisp[0]?.id]);

  // ─── EMPLEADOS ACTIONS ─────────────────────────────────────────────────────
  const puestos = [...new Set(valoresDoble.map(v => v.puesto))];
  const empsFilt = allEmps.filter(e => {
    if (empFiltLocal && e.local_id !== parseInt(empFiltLocal)) return false;
    if (empSearch && !(`${e.apellido} ${e.nombre}`).toLowerCase().includes(empSearch.toLowerCase())) return false;
    return true;
  });

  const guardarEmp = async () => {
    if (!empForm.apellido || !empForm.nombre || !empForm.local_id || !empForm.puesto || !empForm.sueldo_mensual) return;
    const payload = { ...empForm, local_id: parseInt(empForm.local_id), sueldo_mensual: parseFloat(empForm.sueldo_mensual) || 0 };
    if (empModal?.id) {
      const sueldoAnt = Number(empModal.sueldo_mensual);
      if (sueldoAnt !== payload.sueldo_mensual && sueldoAnt > 0) {
        await db.from("rrhh_historial_sueldos").insert([{
          empleado_id: empModal.id, sueldo_anterior: sueldoAnt, sueldo_nuevo: payload.sueldo_mensual,
          motivo: "Edición desde listado", registrado_por: user?.id,
        }]);
      }
      const { valor_dia, valor_hora, creado_at, vacaciones_dias_acumulados, aguinaldo_acumulado, fecha_egreso, motivo_baja, ...upd } = payload as any;
      await db.from("rrhh_empleados").update(upd).eq("id", empModal.id);
    } else {
      await db.from("rrhh_empleados").insert([payload]);
    }
    setEmpModal(null); loadEmpleados();
  };

  const abrirEmpNuevo = () => { setEmpForm({ ...empEmpty, local_id: empFiltLocal || "" }); setEmpModal("new"); };
  const abrirEmpEditar = (e) => {
    setEmpForm({ local_id: e.local_id ? String(e.local_id) : "", apellido:e.apellido, nombre:e.nombre, cuil:e.cuil||"", puesto:e.puesto, modo_pago:e.modo_pago, sueldo_mensual:String(e.sueldo_mensual), alias_mp:e.alias_mp||"", fecha_inicio:e.fecha_inicio||"", activo:e.activo });
    setEmpModal(e);
  };

  // ─── NOVEDADES ACTIONS ─────────────────────────────────────────────────────
  const updateNov = (empId: string, field: string, value: any) => {
    setNovMap(prev => {
      const updated = { ...prev, [empId]: { ...prev[empId], [field]: value } };
      if (saveTimers.current[empId]) clearTimeout(saveTimers.current[empId]);
      saveTimers.current[empId] = setTimeout(() => saveNovedad(empId, updated[empId]), 800);
      return updated;
    });
  };

  const saveNovedad = async (empId: string, nov: any) => {
    const { id, estado, ...rest } = nov;
    await db.from("rrhh_novedades").upsert({
      ...(id ? { id } : {}), empleado_id: empId, mes: novMes, anio: novAnio,
      ...rest, estado: estado || "borrador", cargado_por: user?.id, updated_at: new Date().toISOString(),
    }, { onConflict: "empleado_id,mes,anio" });
  };

  const confirmarMes = async () => {
    if (!novLocal || confirming) return;
    setConfirming(true);
    for (const emp of novEmps) {
      const nov = novMap[emp.id];
      if (!nov) continue;
      const { data: saved } = await db.from("rrhh_novedades").upsert({
        ...(nov.id ? { id: nov.id } : {}), empleado_id: emp.id, mes: novMes, anio: novAnio,
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
        await db.from("rrhh_liquidaciones").upsert({ novedad_id: saved.id, ...calc, estado: "pendiente", calculado_at: new Date().toISOString() }, { onConflict: "novedad_id" });
      }
    }
    setConfirming(false);
    showToast("Mes confirmado");
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

  // ─── PAGOS ACTIONS ─────────────────────────────────────────────────────────
  const pagarUno = async (row: any) => {
    if (pagando) return;
    const { emp, nov, liq } = row;
    if (!liq || liq.estado === "pagado") return;
    setPagando(true);
    try {
      const desc = `Sueldo ${emp.apellido} ${emp.nombre} - ${MESES_NOMBRE[pagoMes]} ${pagoAnio}`;
      const gastoId = genId("GASTO");
      const cuenta = (Number(liq.transferencia) > 0 && emp.alias_mp) ? "MercadoPago" : "Caja Chica";
      const { error: gastoErr } = await db.from("gastos").insert([{ id: gastoId, fecha: toISO(today), tipo:"fijo", categoria:"SUELDOS", monto: Number(liq.total_a_pagar), detalle: desc, local_id: emp.local_id, cuenta }]);
      if (gastoErr) throw new Error("Error gasto: " + gastoErr.message);

      const pagadoPayload = { estado:"pagado", gasto_id: gastoId, pagado_at: new Date().toISOString(), pagado_por: user?.id };

      if (liq._generated && nov?.id) {
        // Crear liquidación directamente como pagada (evita race condition update/select)
        const { _novedadId, _generated, id: _ignoreId, ...calcFields } = liq;
        const { error: insErr } = await db.from("rrhh_liquidaciones").insert([{
          novedad_id: nov.id, ...calcFields, ...pagadoPayload, calculado_at: new Date().toISOString(),
        }]);
        if (insErr) throw new Error("Error liquidación: " + insErr.message);
      } else {
        const { error: updErr } = await db.from("rrhh_liquidaciones").update(pagadoPayload).eq("id", liq.id);
        if (updErr) throw new Error("Error update liquidación: " + updErr.message);
      }

      await db.from("rrhh_empleados").update({ aguinaldo_acumulado: (emp.aguinaldo_acumulado || 0) + Number(liq.total_a_pagar) / 12 }).eq("id", emp.id);
      showToast("Pago registrado");
      await loadPagos();
      await loadEmpleados();
    } catch (err: any) {
      console.error("Error pagarUno:", err);
      alert("Error al registrar el pago: " + err.message);
    } finally {
      setPagando(false);
    }
  };

  const pagarTodos = async () => {
    if (pagando) return;
    const pendientes = pagoData.filter(r => r.liq && r.liq.estado !== "pagado");
    if (!pendientes.length) return;
    setPagando(true);
    for (const row of pendientes) {
      const { emp, nov, liq } = row;
      let liqId = liq.id;
      if (liq._generated && nov?.id) {
        const { _novedadId, _generated, ...calcFields } = liq;
        const { data: created } = await db.from("rrhh_liquidaciones").insert([{
          novedad_id: nov.id, ...calcFields, estado: "pendiente", calculado_at: new Date().toISOString(),
        }]).select().single();
        if (created) liqId = created.id;
      }
      const desc = `Sueldo ${emp.apellido} ${emp.nombre} - ${MESES_NOMBRE[pagoMes]} ${pagoAnio}`;
      const gastoId = genId("GASTO");
      await db.from("gastos").insert([{ id: gastoId, fecha: toISO(today), tipo:"fijo", categoria:"SUELDOS", monto: Number(liq.total_a_pagar), detalle: desc, local_id: emp.local_id, cuenta: emp.alias_mp ? "MercadoPago" : "Caja Chica" }]);
      await db.from("rrhh_liquidaciones").update({ estado:"pagado", gasto_id: gastoId, pagado_at: new Date().toISOString(), pagado_por: user?.id }).eq("id", liqId);
      await db.from("rrhh_empleados").update({ aguinaldo_acumulado: (emp.aguinaldo_acumulado || 0) + Number(liq.total_a_pagar) / 12 }).eq("id", emp.id);
    }
    setPagando(false);
    showToast(`${pendientes.length} pagos registrados`);
    loadPagos(); loadEmpleados();
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

  // ─── RENDER HELPERS ────────────────────────────────────────────────────────
  const inp: any = { padding:"3px 5px", background:"var(--bg)", border:"1px solid var(--bd)", color:"var(--txt)", fontFamily:"'DM Mono',monospace", fontSize:10, borderRadius:"var(--r)", textAlign:"center" };
  const d = dashStats;
  const totalPagosPend = pagoData.filter(r => r.liq && r.liq.estado !== "pagado").length;
  const totalEfvo = pagoData.reduce((s, r) => s + (r.liq ? Number(r.liq.efectivo || 0) : 0), 0);
  const totalTransf = pagoData.reduce((s, r) => s + (r.liq ? Number(r.liq.transferencia || 0) : 0), 0);
  const totalGeneral = pagoData.reduce((s, r) => s + (r.liq ? Number(r.liq.total_a_pagar || 0) : 0), 0);

  const tabs = [
    { id:"dashboard", label:"Dashboard" },
    { id:"empleados", label:"Empleados" },
    { id:"novedades", label:"Novedades" },
    { id:"pagos", label:"Pagos" },
  ];

  return (
    <div>
      {toast && <div style={{position:"fixed",top:16,right:16,zIndex:300,padding:"10px 20px",background:"var(--success)",color:"#000",borderRadius:"var(--r)",fontSize:12,fontFamily:"'DM Mono',monospace",fontWeight:600,boxShadow:"0 4px 12px rgba(0,0,0,.5)"}}>{toast}</div>}

      <div className="ph-row">
        <div><div className="ph-title">RRHH</div><div className="ph-sub">Recursos Humanos</div></div>
        {esDueno && <button className="btn btn-ghost btn-sm" onClick={() => { loadValoresDoble(); setCfgModal(true); }} style={{fontSize:16,padding:"4px 8px"}}>⚙</button>}
      </div>

      <div className="tabs">
        {tabs.map(t => <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</div>)}
      </div>

      {/* ═══ DASHBOARD ═════════════════════════════════════════════════════ */}
      {tab === "dashboard" && (dashLoading ? <div className="loading">Cargando...</div> : <>
        <div className="grid2" style={{marginBottom:16}}>
          {/* Próximo pago */}
          <div className="kpi">
            <div className="kpi-label">Próximo pago de sueldos</div>
            <div className="kpi-value kpi-acc" style={{fontSize:28}}>{d.diasFinMes} días</div>
            <div className="kpi-sub" style={{marginTop:8}}>Estimado: <strong style={{color:"var(--acc)"}}>{fmt_$(d.estimado)}</strong></div>
            <div className="kpi-sub">{d.mensuales} mensuales · {d.quincenales} quincenales · {d.semanales} semanales</div>
          </div>
          {/* SAC */}
          <div className="kpi">
            <div className="kpi-label">Próximo SAC</div>
            <div className="kpi-value" style={{fontSize:28,color:"var(--warn)"}}>{d.diasSAC} días</div>
            <div className="kpi-sub" style={{marginTop:8}}>Fecha: {d.proxSAC} · Acumulado: <strong style={{color:"var(--warn)"}}>{fmt_$(d.totalSAC)}</strong></div>
            <div className="kpi-sub" style={{color:"var(--muted)",fontSize:9}}>SAC = mejor sueldo del semestre / 2 · Se paga en junio y diciembre</div>
          </div>
        </div>
        <div className="grid2">
          {/* Nómina */}
          <div className="kpi">
            <div className="kpi-label">Nómina</div>
            <div className="kpi-value" style={{fontSize:28}}>{d.total}</div>
            <div className="kpi-sub">{d.mensuales} mensuales / {d.quincenales} quinc. / {d.semanales} sem.</div>
            {d.sinCuil > 0 && <div className="kpi-sub" style={{color:"var(--warn)",marginTop:4}}>⚠ {d.sinCuil} sin CUIL registrado</div>}
          </div>
          {/* Estado del mes */}
          <div className="kpi">
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
      </>)}

      {/* ═══ EMPLEADOS ═════════════════════════════════════════════════════ */}
      {tab === "empleados" && (<>
        <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
          <select className="search" style={{width:160}} value={empFiltLocal} onChange={e => setEmpFiltLocal(e.target.value)}>
            {!esEnc && <option value="">Todos los locales</option>}
            {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
          </select>
          <input className="search" placeholder="Buscar..." value={empSearch} onChange={e => setEmpSearch(e.target.value)} style={{width:160}} />
          <div style={{flex:1}} />
          <button className="btn btn-acc" onClick={abrirEmpNuevo}>+ Nuevo empleado</button>
        </div>
        <div className="panel">
          {empsFilt.length === 0 ? <div className="empty">Sin empleados</div> : (
            <div style={{overflowX:"auto"}}>
            <table><thead><tr><th>Nombre</th><th>Local</th><th>Puesto</th><th style={{textAlign:"right"}}>Sueldo</th><th>Modo</th><th>Vacaciones</th><th>CUIL</th><th>Activo</th><th></th></tr></thead>
            <tbody>{empsFilt.map(e => {
              const vac = calcularVacaciones(e.fecha_inicio, vacTomadas[e.id] || 0);
              console.log('[RRHH Debug] emp:', e.apellido, 'fecha_inicio:', e.fecha_inicio, 'vac:', vac);
              const vacColor = vac >= 14 ? "var(--success)" : vac >= 7 ? "var(--warn)" : "var(--muted2)";
              return (
                <tr key={e.id} style={{opacity: e.activo === false ? 0.4 : 1}}>
                  <td style={{fontWeight:500,fontSize:12}}>{e.apellido}, {e.nombre}</td>
                  <td style={{fontSize:11}}>{locales.find(l => l.id === e.local_id)?.nombre || "—"}</td>
                  <td><span className="badge b-muted" style={{fontSize:8}}>{e.puesto}</span></td>
                  <td style={{textAlign:"right"}}><span className="num kpi-acc">{fmt_$(e.sueldo_mensual)}</span></td>
                  <td style={{fontSize:9,color:"var(--muted2)"}}>{e.modo_pago}</td>
                  <td style={{fontSize:11,color:vacColor}}>{vac >= 14 && "🌴 "}{vac.toFixed(1)}d</td>
                  <td className="mono" style={{fontSize:9,color:e.cuil ? "var(--muted2)" : "var(--warn)"}}>{e.cuil || "⚠ sin CUIL"}</td>
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
                <div className="form2">
                  <div className="field"><label>Puesto *</label><select value={empForm.puesto} onChange={e => setEmpForm({...empForm, puesto:e.target.value})}><option value="">Seleccionar...</option>{puestos.map(p => <option key={p} value={p}>{p}</option>)}<option value="__otro">-- Otro --</option></select>
                    {empForm.puesto === "__otro" && <input style={{marginTop:4}} placeholder="Escribir puesto..." onChange={e => setEmpForm({...empForm, puesto:e.target.value})} />}
                  </div>
                  <div className="field"><label>Modo de pago *</label><select value={empForm.modo_pago} onChange={e => setEmpForm({...empForm, modo_pago:e.target.value})}><option value="MENSUAL">Mensual</option><option value="QUINCENAL">Quincenal</option><option value="SEMANAL">Semanal</option></select></div>
                </div>
                <div className="form3">
                  <div className="field"><label>Sueldo mensual *</label><input type="number" value={empForm.sueldo_mensual} onChange={e => setEmpForm({...empForm, sueldo_mensual:e.target.value})} placeholder="0" /></div>
                  <div className="field"><label>CBU / Alias</label><input value={empForm.alias_mp} onChange={e => setEmpForm({...empForm, alias_mp:e.target.value})} /></div>
                  <div className="field"><label>Fecha inicio</label><input type="date" value={empForm.fecha_inicio} onChange={e => setEmpForm({...empForm, fecha_inicio:e.target.value})} /></div>
                </div>
                <div className="field"><label>Activo</label><select value={empForm.activo ? "1" : "0"} onChange={e => setEmpForm({...empForm, activo:e.target.value === "1"})}><option value="1">Si</option><option value="0">No</option></select></div>
              </div>
              <div className="modal-ft"><button className="btn btn-sec" onClick={() => setEmpModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEmp}>Guardar</button></div>
            </div>
          </div>
        )}
      </>)}

      {/* ═══ NOVEDADES ═════════════════════════════════════════════════════ */}
      {tab === "novedades" && (<>
        <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
          <select className="search" style={{width:100}} value={novMes} onChange={e => setNovMes(parseInt(e.target.value))}>
            {MESES_SEL.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
          </select>
          <input type="number" className="search" style={{width:70}} value={novAnio} onChange={e => setNovAnio(parseInt(e.target.value))} />
          <select className="search" style={{width:160}} value={String(novLocal || "")} onChange={e => setNovLocal(e.target.value)}>
            <option value="">Seleccionar local...</option>
            {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
          </select>
        </div>

        {!novLocal ? <div className="alert alert-info">Seleccioná un local para cargar novedades</div> :
         novLoading ? <div className="loading">Cargando...</div> :
         novEmps.length === 0 ? <div className="empty">Sin empleados activos en este local</div> : (
          <div className="panel">
            <div style={{overflowX:"auto"}}>
            <table>
              <thead><tr>
                <th style={{minWidth:120,fontSize:8}}>Empleado</th><th style={{width:50,fontSize:8}}>Inasist.</th><th style={{width:90,fontSize:8}}>Present.</th>
                <th style={{width:50,fontSize:8}}>Días</th><th style={{width:50,fontSize:8}}>HS Ex.</th><th style={{width:50,fontSize:8}}>Dobles</th>
                <th style={{width:65,fontSize:8}}>Pag.dob.$</th><th style={{width:50,fontSize:8}}>Ferid.</th><th style={{width:65,fontSize:8}}>Adel.$</th>
                <th style={{width:50,fontSize:8}}>Vac.</th><th style={{width:90,fontSize:8}}>Obs.</th><th style={{textAlign:"right",width:80,fontSize:8}}>Preview</th><th style={{width:50,fontSize:8}}>Estado</th>
              </tr></thead>
              <tbody>{novEmps.map(emp => {
                const nov = novMap[emp.id] || {};
                const locked = nov.estado === "confirmado";
                const vd = valoresDoble.find(v => v.puesto === emp.puesto)?.valor || 0;
                const preview = calcLiquidacion(emp, nov, vd).total_a_pagar;
                return (
                  <tr key={emp.id}>
                    <td style={{fontWeight:500,fontSize:10}}>{emp.apellido}, {emp.nombre}</td>
                    <td><input type="number" style={{...inp,width:40}} disabled={locked} value={nov.inasistencias ?? 0} onChange={e => updateNov(emp.id, "inasistencias", parseFloat(e.target.value) || 0)} /></td>
                    <td><select style={{...inp,width:82,textAlign:"left"}} disabled={locked} value={nov.presentismo || "MANTIENE"} onChange={e => updateNov(emp.id, "presentismo", e.target.value)}>
                      {PRESENTISMO_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select></td>
                    <td><input type="number" style={{...inp,width:40}} disabled={locked} value={nov.dias_trabajados ?? ""} onChange={e => updateNov(emp.id, "dias_trabajados", e.target.value ? parseFloat(e.target.value) : null)} /></td>
                    <td><input type="number" style={{...inp,width:40}} disabled={locked} value={nov.horas_extras ?? 0} onChange={e => updateNov(emp.id, "horas_extras", parseFloat(e.target.value) || 0)} /></td>
                    <td><input type="number" style={{...inp,width:40}} disabled={locked} value={nov.dobles ?? 0} onChange={e => updateNov(emp.id, "dobles", parseFloat(e.target.value) || 0)} /></td>
                    <td><input type="number" style={{...inp,width:55}} disabled={locked} value={nov.pagos_dobles_realizados ?? 0} onChange={e => updateNov(emp.id, "pagos_dobles_realizados", parseFloat(e.target.value) || 0)} /></td>
                    <td><input type="number" style={{...inp,width:40}} disabled={locked} value={nov.feriados ?? 0} onChange={e => updateNov(emp.id, "feriados", parseFloat(e.target.value) || 0)} /></td>
                    <td><input type="number" style={{...inp,width:55}} disabled={locked} value={nov.adelantos ?? 0} onChange={e => updateNov(emp.id, "adelantos", parseFloat(e.target.value) || 0)} /></td>
                    <td><input type="number" style={{...inp,width:40}} disabled={locked} value={nov.vacaciones_dias ?? 0} onChange={e => updateNov(emp.id, "vacaciones_dias", parseFloat(e.target.value) || 0)} /></td>
                    <td><input style={{...inp,width:80,textAlign:"left"}} disabled={locked} value={nov.observaciones || ""} onChange={e => updateNov(emp.id, "observaciones", e.target.value)} /></td>
                    <td style={{textAlign:"right"}}><span className="num" style={{color: preview < 0 ? "var(--danger)" : "var(--success)",fontSize:11}}>{fmt_$(preview)}</span></td>
                    <td><span className={`badge ${nov.estado === "confirmado" ? "b-success" : "b-muted"}`} style={{fontSize:7}}>{nov.estado === "confirmado" ? "OK" : "Borr."}</span></td>
                  </tr>
                );
              })}</tbody>
            </table>
            </div>
            <div style={{padding:"12px 16px",display:"flex",justifyContent:"flex-end",gap:8}}>
              {esDueno && allConfirmado && <button className="btn btn-ghost btn-sm" onClick={reabrirMes}>Reabrir mes</button>}
              {!allConfirmado && <button className="btn btn-acc" onClick={confirmarMes} disabled={!canConfirm || confirming}>{confirming ? "Confirmando..." : "Confirmar mes"}</button>}
            </div>
          </div>
        )}
      </>)}

      {/* ═══ PAGOS ═════════════════════════════════════════════════════════ */}
      {tab === "pagos" && (<>
        <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
          <select className="search" style={{width:100}} value={pagoMes} onChange={e => setPagoMes(parseInt(e.target.value))}>
            {MESES_SEL.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
          </select>
          <input type="number" className="search" style={{width:70}} value={pagoAnio} onChange={e => setPagoAnio(parseInt(e.target.value))} />
          <select className="search" style={{width:160}} value={String(pagoLocal || "")} onChange={e => setPagoLocal(e.target.value)}>
            {!esEnc && <option value="">Seleccionar local...</option>}
            {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
          </select>
          <div style={{flex:1}} />
          {esDueno && totalPagosPend > 0 && (
            <button className="btn btn-success" onClick={pagarTodos} disabled={pagando}>{pagando ? "Pagando..." : `Pagar todos (${totalPagosPend})`}</button>
          )}
        </div>

        {!pagoLocal ? <div className="alert alert-info">Seleccioná un local</div> :
         pagoLoading ? <div className="loading">Cargando...</div> :
         pagoData.length === 0 ? <div className="alert alert-warn">Confirmá las novedades primero en el tab Novedades</div> : (<>
          <div className="panel">
            <div style={{overflowX:"auto"}}>
            <table>
              <thead><tr><th>Empleado</th><th style={{textAlign:"right"}}>Total</th><th style={{textAlign:"right"}}>Efectivo</th><th style={{textAlign:"right"}}>Transferencia</th><th>CBU / Alias</th><th>Estado</th><th></th></tr></thead>
              <tbody>{pagoData.map((row, idx) => {
                const { emp, nov, liq } = row;
                if (!liq) return null;
                const pagado = liq.estado === "pagado";
                const updateSplit = (campo: "efectivo"|"transferencia", valor: number) => {
                  setPagoData(prev => prev.map((r, i) => i === idx ? { ...r, liq: { ...r.liq, [campo]: valor } } : r));
                };
                return (
                  <tr key={emp.id}>
                    <td style={{fontWeight:500,fontSize:12}}>{emp.apellido}, {emp.nombre}</td>
                    <td style={{textAlign:"right"}}><span className="num" style={{color:"var(--acc)"}}>{fmt_$(liq.total_a_pagar)}</span></td>
                    <td style={{textAlign:"right",fontSize:11}}>
                      {pagado ? fmt_$(liq.efectivo) : <input type="number" value={Number(liq.efectivo)||0} onChange={e => updateSplit("efectivo", parseFloat(e.target.value)||0)} style={{width:90,background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--acc)",padding:"3px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)",textAlign:"right"}}/>}
                    </td>
                    <td style={{textAlign:"right",fontSize:11,color:"var(--info)"}}>
                      {pagado ? fmt_$(liq.transferencia) : <input type="number" value={Number(liq.transferencia)||0} onChange={e => updateSplit("transferencia", parseFloat(e.target.value)||0)} style={{width:90,background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--info)",padding:"3px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)",textAlign:"right"}}/>}
                    </td>
                    <td className="mono" style={{fontSize:10,color:"var(--muted2)"}}>{emp.alias_mp || "—"}</td>
                    <td>
                      {pagado
                        ? <span className="badge b-success">{fmt_d(liq.pagado_at?.split("T")[0])}</span>
                        : <span className="badge b-warn">Pendiente</span>}
                    </td>
                    <td>
                      {esDueno && !pagado && (
                        <button className="btn btn-success btn-sm" onClick={() => pagarUno({ emp, nov, liq })} disabled={pagando}>Pagar</button>
                      )}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
            </div>
            {/* Totales */}
            <div style={{padding:"12px 16px",borderTop:"1px solid var(--bd)",display:"flex",justifyContent:"flex-end",gap:24,fontSize:12}}>
              <span>Efectivo: <strong style={{color:"var(--acc)"}}>{fmt_$(totalEfvo)}</strong></span>
              <span>Transferencia: <strong style={{color:"var(--info)"}}>{fmt_$(totalTransf)}</strong></span>
              <span>Total: <strong style={{color:"var(--success)"}}>{fmt_$(totalGeneral)}</strong></span>
            </div>
          </div>
        </>)}
      </>)}

      {/* ═══ LEGAJO MODAL ═════════════════════════════════════════════════ */}
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

      {/* ═══ CONFIG MODAL ═════════════════════════════════════════════════ */}
      {cfgModal && (
        <div className="overlay" onClick={() => setCfgModal(false)}>
          <div className="modal" style={{width:500}} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Configuración — Valores de dobles</div><button className="close-btn" onClick={() => setCfgModal(false)}>✕</button></div>
            <div className="modal-body">
              <table>
                <thead><tr><th>Puesto</th><th style={{textAlign:"right"}}>Valor doble $</th><th></th></tr></thead>
                <tbody>{valoresDoble.map(v => (
                  <tr key={v.id}>
                    <td style={{fontWeight:500,fontSize:11}}>{v.puesto}</td>
                    <td style={{textAlign:"right"}}>
                      {cfgEdit?.id === v.id
                        ? <input type="number" style={{...inp,width:100}} value={cfgEdit.valor} onChange={e => setCfgEdit({...cfgEdit, valor:e.target.value})} onKeyDown={e => e.key === "Enter" && guardarValorDoble(cfgEdit)} autoFocus />
                        : <span className="num kpi-acc">{fmt_$(v.valor)}</span>}
                    </td>
                    <td style={{textAlign:"right"}}>
                      {cfgEdit?.id === v.id
                        ? <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}><button className="btn btn-acc btn-sm" onClick={() => guardarValorDoble(cfgEdit)}>OK</button><button className="btn btn-ghost btn-sm" onClick={() => setCfgEdit(null)}>X</button></div>
                        : <button className="btn btn-ghost btn-sm" onClick={() => setCfgEdit({...v})}>Editar</button>}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="modal-ft"><button className="btn btn-acc btn-sm" onClick={agregarPuesto}>+ Agregar puesto</button><div style={{flex:1}}/><button className="btn btn-sec" onClick={() => setCfgModal(false)}>Cerrar</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
