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
    modo_pago: "MENSUAL",
    inasistencias: nov.inasistencias || 0,
    horas_extras: nov.horas_extras || 0,
    dobles: nov.dobles || 0,
    valor_doble: valorDoble,
    feriados: nov.feriados || 0,
    vacaciones_dias: nov.vacaciones_dias || 0,
    presentismo_mantiene: nov.presentismo === "MANTIENE",
    adelantos: nov.adelantos || 0,
    pagos_dobles_realizados: 0,
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
  { value:"MANTIENE", label:"Tiene" },
  { value:"PIERDE", label:"No tiene" },
];
const CUENTAS_PAGO = ["Caja Efectivo","Caja Chica","Caja Mayor","MercadoPago","Banco"];

const inp: any = { padding:"3px 5px", background:"var(--bg)", border:"1px solid var(--bd)", color:"var(--txt)", fontFamily:"'DM Mono',monospace", fontSize:10, borderRadius:"var(--r)", textAlign:"center" };

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
  const empEmpty = { local_id:"", apellido:"", nombre:"", cuil:"", puesto:"", sueldo_mensual:"", alias_mp:"", fecha_inicio:"", activo:true };
  const [empForm, setEmpForm] = useState(empEmpty);

  // Novedades
  const [novMes, setNovMes] = useState(today.getMonth() + 1);
  const [novAnio, setNovAnio] = useState(today.getFullYear());
  const [novLocal, setNovLocal] = useState(defaultLocal);
  const [novEmps, setNovEmps] = useState<any[]>([]);
  const [novMap, setNovMap] = useState<Record<string, any>>({});
  const [novLoading, setNovLoading] = useState(false);
  const saveTimers = useRef<Record<string, any>>({});

  // Pagos
  const [pagoMes, setPagoMes] = useState(today.getMonth() + 1);
  const [pagoAnio, setPagoAnio] = useState(today.getFullYear());
  const [pagoLocal, setPagoLocal] = useState(defaultLocal);
  const [pagoData, setPagoData] = useState<any[]>([]);
  const [pagoLoading, setPagoLoading] = useState(false);
  const [pagando, setPagando] = useState(false);
  const [pagoModal, setPagoModal] = useState<any>(null);
  const [formasPago, setFormasPago] = useState<{cuenta:string, monto:string}[]>([]);
  const [adelantosPendientes, setAdelantosPendientes] = useState<any[]>([]);
  const [adelModal, setAdelModal] = useState(false);
  const [adelForm, setAdelForm] = useState({ empleado_id:"", monto:"", cuenta:"Caja Efectivo", fecha:toISO(today), descripcion:"" });

  // Dashboard
  const [dashLoading, setDashLoading] = useState(true);
  const [dashStats, setDashStats] = useState<any>({});

  // Historial
  const [histLocal, setHistLocal] = useState(defaultLocal);
  const [histMes, setHistMes] = useState(today.getMonth() + 1);
  const [histAnio, setHistAnio] = useState(today.getFullYear());
  const [histData, setHistData] = useState<any[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histDetalle, setHistDetalle] = useState<any>(null);

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
      map[e.id] = existing || { inasistencias:0, presentismo:"MANTIENE", horas_extras:0, dobles:0, feriados:0, adelantos:0, fecha_inicio_mes:null, observaciones:"", estado:"borrador" };
    });
    setNovEmps(emps || []);
    setNovMap(map);
    setNovLoading(false);
  };

  const loadPagos = async () => {
    if (!pagoLocal) return;
    setPagoLoading(true);

    const { data: emps } = await db.from("rrhh_empleados")
      .select("*").eq("local_id", parseInt(pagoLocal)).eq("activo", true).order("apellido");
    const empIds = (emps || []).map(e => e.id);

    if (!empIds.length) { setPagoData([]); setPagoLoading(false); return; }

    const { data: novs } = await db.from("rrhh_novedades")
      .select("*")
      .eq("mes", pagoMes).eq("anio", pagoAnio)
      .eq("estado", "confirmado")
      .in("empleado_id", empIds);

    const novIds = (novs || []).map(n => n.id);

    // Query separada para liquidaciones (evita problemas con nested select y FK)
    let liqs: any[] = [];
    if (novIds.length) {
      const { data } = await db.from("rrhh_liquidaciones")
        .select("*").in("novedad_id", novIds);
      liqs = data || [];
    }

    const merged = (emps || []).map(emp => {
      const nov = novs?.find(n => n.empleado_id === emp.id);
      if (!nov) return null;

      let liq = liqs.find(l => l.novedad_id === nov.id) || null;

      if (!liq) {
        const vd = valoresDoble.find(v => v.puesto === emp.puesto)?.valor || 0;
        const calc = calcLiquidacion(emp, nov, vd);
        liq = { ...calc, total_a_pagar: Math.round(calc.total_a_pagar), estado: "pendiente", _novedadId: nov.id, _generated: true };
      }

      return { emp, nov, liq };
    }).filter(Boolean);

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
    const sinDatos = activos.filter(e =>
      !e.cuil || !e.fecha_inicio || !e.sueldo_mensual || e.sueldo_mensual <= 0
    ).length;
    const conNovedades = novsMes.length;
    const confirmadas = novsMes.filter(n => n.estado === "confirmado").length;
    const novIds = novsMes.map(n => n.id);
    let liqsDash: any[] = [];
    if (novIds.length) {
      const { data: liqData } = await db.from("rrhh_liquidaciones")
        .select("novedad_id, estado, total_a_pagar")
        .in("novedad_id", novIds);
      liqsDash = liqData || [];
    }
    const pagados = novsMes.filter(n => {
      const liq = liqsDash.find(l => l.novedad_id === n.id);
      return liq?.estado === "pagado";
    }).length;
    // Estimado a pagar
    let estimado = 0;
    activos.forEach(emp => {
      const nov = novsMes.find(n => n.empleado_id === emp.id);
      if (nov && nov.estado === "confirmado") {
        const liq = liqsDash.find(l => l.novedad_id === nov.id);
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
      total: activos.length, sinDatos,
      conNovedades, confirmadas, pagados, estimado, totalSAC,
      proxSAC: proxSAC.toLocaleDateString("es-AR"), diasSAC, diasFinMes,
      mes, anio,
    });
    setDashLoading(false);
  };

  const loadHistorial = async () => {
    setHistLoading(true);
    const desde = `${histAnio}-${String(histMes).padStart(2,"0")}-01`;
    const hasta = `${histAnio}-${String(histMes).padStart(2,"0")}-${String(new Date(histAnio,histMes,0).getDate()).padStart(2,"0")}`;

    const { data: liqs } = await db.from("rrhh_liquidaciones")
      .select("*, rrhh_novedades(mes, anio, empleado_id, inasistencias, presentismo, horas_extras, dobles, feriados, adelantos, observaciones, rrhh_empleados(nombre, apellido, puesto, local_id))")
      .eq("estado", "pagado")
      .gte("pagado_at", desde + "T00:00:00")
      .lte("pagado_at", hasta + "T23:59:59");

    const { data: especiales } = await db.from("rrhh_pagos_especiales")
      .select("*, rrhh_empleados(nombre, apellido, puesto, local_id)")
      .gte("pagado_at", desde + "T00:00:00")
      .lte("pagado_at", hasta + "T23:59:59");

    const { data: adelantos } = await db.from("rrhh_adelantos")
      .select("*, rrhh_empleados(nombre, apellido, puesto, local_id)")
      .gte("fecha", desde)
      .lte("fecha", hasta);

    const sueldos = (liqs || []).map(l => ({
      tipo: "sueldo",
      fecha: l.pagado_at?.split("T")[0],
      emp: l.rrhh_novedades?.rrhh_empleados,
      nov: l.rrhh_novedades,
      liq: l,
      monto: l.total_a_pagar,
      label: `Sueldo ${MESES_NOMBRE[l.rrhh_novedades?.mes || 0]} ${l.rrhh_novedades?.anio || ""}`,
    }));

    const esp = (especiales || []).map(e => ({
      tipo: e.tipo,
      fecha: e.pagado_at?.split("T")[0],
      emp: e.rrhh_empleados,
      monto: Number(e.monto_pagado) > 0 ? Number(e.monto_pagado) : Number(e.monto),
      label: (e.tipo === "vacaciones" ? "Vacaciones" : e.tipo === "aguinaldo" ? "Aguinaldo" : "Liquidación final") + (e.pendiente ? " (parcial)" : ""),
      detalle: e,
    }));

    const adel = (adelantos || []).map(a => ({
      tipo: "adelanto",
      fecha: a.fecha,
      emp: a.rrhh_empleados,
      monto: a.monto,
      label: "Adelanto",
      detalle: a,
    }));

    const todos = [...sueldos, ...esp, ...adel]
      .filter(h => !histLocal || String(h.emp?.local_id) === String(histLocal))
      .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

    setHistData(todos);
    setHistLoading(false);
  };

  useEffect(() => { loadValoresDoble(); loadEmpleados(); }, []);
  useEffect(() => { if (tab === "dashboard") loadDashboard(); }, [tab]);
  useEffect(() => { if (tab === "novedades" && novLocal) loadNovedades(); }, [tab, novLocal, novMes, novAnio]);
  useEffect(() => { if (tab === "pagos" && pagoLocal) loadPagos(); }, [tab, pagoLocal, pagoMes, pagoAnio]);
  useEffect(() => { if (tab === "historial") loadHistorial(); }, [tab, histLocal, histMes, histAnio]);

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
    setEmpForm({ local_id: e.local_id ? String(e.local_id) : "", apellido:e.apellido, nombre:e.nombre, cuil:e.cuil||"", puesto:e.puesto, sueldo_mensual:String(e.sueldo_mensual), alias_mp:e.alias_mp||"", fecha_inicio:e.fecha_inicio||"", activo:e.activo });
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
    const { id, estado, vacaciones_dias: _vac, ...rest } = nov;
    await db.from("rrhh_novedades").upsert({
      ...(id ? { id } : {}), empleado_id: empId, mes: novMes, anio: novAnio,
      ...rest, estado: estado || "borrador", cargado_por: user?.id, updated_at: new Date().toISOString(),
    }, { onConflict: "empleado_id,mes,anio" });
  };

  const confirmarUno = async (emp: any) => {
    const nov = novMap[emp.id];
    if (!nov) return;
    const { data: saved } = await db.from("rrhh_novedades").upsert({
      ...(nov.id ? { id: nov.id } : {}),
      empleado_id: emp.id, mes: novMes, anio: novAnio,
      inasistencias: nov.inasistencias || 0,
      presentismo: nov.presentismo || "MANTIENE",
      horas_extras: nov.horas_extras || 0,
      dobles: nov.dobles || 0,
      feriados: nov.feriados || 0,
      adelantos: nov.adelantos || 0,
      fecha_inicio_mes: nov.fecha_inicio_mes || null,
      observaciones: nov.observaciones || "",
      estado: "confirmado",
      cargado_por: user?.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: "empleado_id,mes,anio" }).select().single();

    if (saved) {
      const vd = valoresDoble.find(v => v.puesto === emp.puesto)?.valor || 0;
      const calc = calcLiquidacion(emp, nov, vd);
      await db.from("rrhh_liquidaciones").upsert({
        novedad_id: saved.id, ...calc, estado: "pendiente",
        calculado_at: new Date().toISOString(),
      }, { onConflict: "novedad_id" });
    }
    showToast(`${emp.apellido} confirmado`);
    loadNovedades();
  };

  const editarNov = async (empId: string) => {
    const nov = novMap[empId];
    if (!nov?.id) return;
    await db.from("rrhh_liquidaciones").delete().eq("novedad_id", nov.id);
    await db.from("rrhh_novedades").update({ estado: "borrador" }).eq("id", nov.id);
    setNovMap(prev => ({ ...prev, [empId]: { ...prev[empId], estado: "borrador" } }));
  };

  // ─── ADELANTOS ─────────────────────────────────────────────────────────────
  const abrirPagoSueldo = async (emp: any, nov: any, liq: any) => {
    const { data: adelantos } = await db.from("rrhh_adelantos")
      .select("*")
      .eq("empleado_id", emp.id)
      .eq("descontado", false)
      .order("fecha");
    const pendientes = adelantos || [];
    const totalAdelantos = pendientes.reduce((s, a) => s + Number(a.monto), 0);
    const total = Math.round(Number(liq.total_a_pagar || 0));
    const yaPagado = Math.round(Number(liq.pagos_realizados || 0));
    const pendienteCash = Math.max(0, total - yaPagado - Math.round(totalAdelantos));
    setAdelantosPendientes(pendientes);
    setPagoModal({ emp, nov, liq });
    setFormasPago(pendienteCash > 0 ? [{ cuenta: "Caja Efectivo", monto: String(pendienteCash) }] : []);
  };

  const guardarAdelanto = async () => {
    const monto = parseFloat(adelForm.monto);
    if (!monto || monto <= 0 || !adelForm.empleado_id || !adelForm.cuenta) return;
    const emp = allEmps.find(e => e.id === adelForm.empleado_id);
    if (!emp) return;
    const lid = emp.local_id;
    const desc = adelForm.descripcion
      ? `Adelanto ${emp.apellido} ${emp.nombre} — ${adelForm.descripcion}`
      : `Adelanto ${emp.apellido} ${emp.nombre}`;

    await db.from("movimientos").insert([{
      id: genId("MOV"), fecha: adelForm.fecha, cuenta: adelForm.cuenta,
      tipo: "Adelanto", cat: "SUELDOS", importe: -monto, detalle: desc,
      local_id: lid,
    }]);
    if (lid) {
      const { data: caja } = await db.from("saldos_caja").select("saldo")
        .eq("cuenta", adelForm.cuenta).eq("local_id", lid).maybeSingle();
      if (caja) await db.from("saldos_caja")
        .update({ saldo: (caja.saldo || 0) - monto })
        .eq("cuenta", adelForm.cuenta).eq("local_id", lid);
    }
    await db.from("rrhh_adelantos").insert([{
      empleado_id: adelForm.empleado_id,
      monto, fecha: adelForm.fecha,
      local_id: lid, cuenta: adelForm.cuenta,
      descontado: false,
      registrado_por: user?.nombre || null,
    }]);

    showToast(`Adelanto registrado — ${emp.apellido}`);
    setAdelModal(false);
    setAdelForm({ empleado_id:"", monto:"", cuenta:"Caja Efectivo", fecha:toISO(today), descripcion:"" });
    if (tab === "pagos") await loadPagos();
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

  // ─── DERIVED ───────────────────────────────────────────────────────────────
  const totalPagosPend = pagoData.filter(r => r.liq && r.liq.estado !== "pagado").length;
  const totalGeneral = pagoData.reduce((s, r) => s + (r.liq ? Number(r.liq.total_a_pagar || 0) : 0), 0);

  const tabs = [
    { id:"dashboard", label:"Dashboard" },
    { id:"empleados", label:"Empleados" },
    { id:"novedades", label:"Novedades" },
    { id:"pagos", label:"Pagos" },
    { id:"historial", label:"Historial" },
  ];

  return (
    <div>
      {toast && <div style={{position:"fixed",top:16,right:16,zIndex:300,padding:"10px 20px",background:"var(--success)",color:"#000",borderRadius:"var(--r)",fontSize:12,fontFamily:"'DM Mono',monospace",fontWeight:600,boxShadow:"0 4px 12px rgba(0,0,0,.5)"}}>{toast}</div>}

      <div className="ph-row">
        <div><div className="ph-title">RRHH</div></div>
        {esDueno && <button className="btn btn-ghost btn-sm" onClick={() => { loadValoresDoble(); setCfgModal(true); }} style={{fontSize:16,padding:"4px 8px"}}>⚙</button>}
      </div>

      <div className="tabs">
        {tabs.map(t => <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</div>)}
      </div>

      {tab === "dashboard" && <TabDashboard dashStats={dashStats} dashLoading={dashLoading} />}

      {tab === "empleados" && (
        <TabEmpleados
          empFiltLocal={empFiltLocal}
          setEmpFiltLocal={setEmpFiltLocal}
          empSearch={empSearch}
          setEmpSearch={setEmpSearch}
          esEnc={esEnc}
          locsDisp={locsDisp}
          locales={locales}
          empsFilt={empsFilt}
          vacTomadas={vacTomadas}
          puestos={puestos}
          empModal={empModal}
          setEmpModal={setEmpModal}
          empForm={empForm}
          setEmpForm={setEmpForm}
          abrirEmpNuevo={abrirEmpNuevo}
          abrirEmpEditar={abrirEmpEditar}
          guardarEmp={guardarEmp}
          setLegajoId={setLegajoId}
        />
      )}

      {tab === "novedades" && (
        <TabNovedades
          novMes={novMes}
          setNovMes={setNovMes}
          novAnio={novAnio}
          setNovAnio={setNovAnio}
          novLocal={novLocal}
          setNovLocal={setNovLocal}
          locsDisp={locsDisp}
          novLoading={novLoading}
          novEmps={novEmps}
          novMap={novMap}
          valoresDoble={valoresDoble}
          updateNov={updateNov}
          confirmarUno={confirmarUno}
          editarNov={editarNov}
          esDueno={esDueno}
        />
      )}

      {tab === "pagos" && (
        <TabPagos
          pagoMes={pagoMes}
          setPagoMes={setPagoMes}
          pagoAnio={pagoAnio}
          setPagoAnio={setPagoAnio}
          pagoLocal={pagoLocal}
          setPagoLocal={setPagoLocal}
          locsDisp={locsDisp}
          esEnc={esEnc}
          esDueno={esDueno}
          pagoLoading={pagoLoading}
          pagoData={pagoData}
          totalPagosPend={totalPagosPend}
          totalGeneral={totalGeneral}
          pagoModal={pagoModal}
          setPagoModal={setPagoModal}
          formasPago={formasPago}
          setFormasPago={setFormasPago}
          pagando={pagando}
          setPagando={setPagando}
          loadPagos={loadPagos}
          loadEmpleados={loadEmpleados}
          showToast={showToast}
          user={user}
          allEmps={allEmps}
          adelModal={adelModal}
          setAdelModal={setAdelModal}
          adelForm={adelForm}
          setAdelForm={setAdelForm}
          guardarAdelanto={guardarAdelanto}
          adelantosPendientes={adelantosPendientes}
          setAdelantosPendientes={setAdelantosPendientes}
          abrirPagoSueldo={abrirPagoSueldo}
        />
      )}

      {tab === "historial" && (
        <TabHistorial
          histMes={histMes}
          setHistMes={setHistMes}
          histAnio={histAnio}
          setHistAnio={setHistAnio}
          histLocal={histLocal}
          setHistLocal={setHistLocal}
          locsDisp={locsDisp}
          esEnc={esEnc}
          histLoading={histLoading}
          histData={histData}
          histDetalle={histDetalle}
          setHistDetalle={setHistDetalle}
        />
      )}

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

// ─── SUB-COMPONENTES ─────────────────────────────────────────────────────────

function TabDashboard({ dashStats, dashLoading }: { dashStats: any; dashLoading: boolean }) {
  if (dashLoading) return <div className="loading">Cargando...</div>;
  const d = dashStats;
  return (
    <>
      <div className="grid2" style={{marginBottom:16}}>
        {/* Próximo pago */}
        <div className="kpi">
          <div className="kpi-label">Próximo pago de sueldos</div>
          <div className="kpi-value kpi-acc" style={{fontSize:18}}>{d.diasFinMes} días</div>
          <div className="kpi-sub" style={{marginTop:8}}>Estimado: <strong style={{color:"var(--acc)"}}>{fmt_$(d.estimado)}</strong></div>
          <div className="kpi-sub">{d.total} empleados activos</div>
        </div>
        {/* SAC */}
        <div className="kpi">
          <div className="kpi-label">Próximo SAC</div>
          <div className="kpi-value" style={{fontSize:18,color:"var(--warn)"}}>{d.diasSAC} días</div>
          <div className="kpi-sub" style={{marginTop:8}}>Fecha: {d.proxSAC} · Acumulado: <strong style={{color:"var(--warn)"}}>{fmt_$(d.totalSAC)}</strong></div>
          <div className="kpi-sub" style={{color:"var(--muted)",fontSize:9}}>SAC = mejor sueldo del semestre / 2 · Se paga en junio y diciembre</div>
        </div>
      </div>
      <div className="grid2">
        {/* Nómina */}
        <div className="kpi">
          <div className="kpi-label">Nómina</div>
          <div className="kpi-value" style={{fontSize:18}}>{d.total}</div>
          <div className="kpi-sub">empleados activos</div>
          {d.sinDatos > 0 && <div className="kpi-sub" style={{color:"var(--warn)",marginTop:4}}>⚠ {d.sinDatos} con datos incompletos</div>}
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
    </>
  );
}

function TabEmpleados({
  empFiltLocal, setEmpFiltLocal, empSearch, setEmpSearch,
  esEnc, locsDisp, locales, empsFilt, vacTomadas, puestos,
  empModal, setEmpModal, empForm, setEmpForm,
  abrirEmpNuevo, abrirEmpEditar, guardarEmp, setLegajoId,
}: any) {
  return (
    <>
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
                <td style={{fontSize:11}}>{locales.find(l => l.id === e.local_id)?.nombre || "—"}</td>
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
                <div className="field"><label>Fecha inicio</label><input type="date" value={empForm.fecha_inicio} onChange={e => setEmpForm({...empForm, fecha_inicio:e.target.value})} /></div>
              </div>
              <div className="field"><label>Activo</label><select value={empForm.activo ? "1" : "0"} onChange={e => setEmpForm({...empForm, activo:e.target.value === "1"})}><option value="1">Si</option><option value="0">No</option></select></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={() => setEmpModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEmp}>Guardar</button></div>
          </div>
        </div>
      )}
    </>
  );
}

function TabNovedades({
  novMes, setNovMes, novAnio, setNovAnio, novLocal, setNovLocal,
  locsDisp, novLoading, novEmps, novMap, valoresDoble,
  updateNov, confirmarUno, editarNov, esDueno,
}: any) {
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
              const vd = valoresDoble.find(v => v.puesto === emp.puesto)?.valor || 0;
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

function TabPagos({
  pagoMes, setPagoMes, pagoAnio, setPagoAnio, pagoLocal, setPagoLocal,
  locsDisp, esEnc, esDueno, pagoLoading, pagoData,
  totalPagosPend, totalGeneral,
  pagoModal, setPagoModal, formasPago, setFormasPago,
  pagando, setPagando, loadPagos, loadEmpleados, showToast, user,
  allEmps, adelModal, setAdelModal, adelForm, setAdelForm, guardarAdelanto,
  adelantosPendientes, setAdelantosPendientes, abrirPagoSueldo,
}: any) {
  return (
    <>
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
        {totalPagosPend > 0 && <span style={{fontSize:11,color:"var(--muted2)"}}>{totalPagosPend} pendiente{totalPagosPend > 1 ? "s" : ""}</span>}
        {esDueno && <button className="btn btn-sec btn-sm" onClick={() => setAdelModal(true)}>+ Adelanto</button>}
      </div>

      {!pagoLocal ? <div className="alert alert-info">Seleccioná un local</div> :
       pagoLoading ? <div className="loading">Cargando...</div> :
       pagoData.length === 0 ? <div className="alert alert-warn">Confirmá las novedades primero en el tab Novedades</div> : (<>
        <div className="panel">
          <div style={{overflowX:"auto"}}>
          <table>
            <thead><tr><th>Empleado</th><th>Puesto</th><th style={{textAlign:"right"}}>Total</th><th>CBU / Alias</th><th>Estado</th><th></th></tr></thead>
            <tbody>{pagoData.map((row) => {
              const { emp, nov, liq } = row;
              if (!liq) return null;
              const pagado = liq.estado === "pagado";
              const yaPagado = Number(liq.pagos_realizados || 0);
              const total = Number(liq.total_a_pagar || 0);
              const pendiente = Math.max(0, Math.round(total) - Math.round(yaPagado));
              const esParcial = !pagado && yaPagado > 0;
              const pct = total > 0 ? Math.round((yaPagado / total) * 100) : 0;
              return (
                <tr key={emp.id}>
                  <td style={{fontWeight:500,fontSize:12}}>{emp.apellido}, {emp.nombre}</td>
                  <td><span className="badge b-muted" style={{fontSize:8}}>{emp.puesto}</span></td>
                  <td style={{textAlign:"right"}}><span className="num" style={{color:"var(--acc)"}}>{fmt_$(total)}</span></td>
                  <td className="mono" style={{fontSize:10,color:"var(--muted2)"}}>{emp.alias_mp || "—"}</td>
                  <td>
                    {pagado
                      ? <span className="badge b-success">{fmt_d(liq.pagado_at?.split("T")[0])}</span>
                      : esParcial
                        ? <span className="badge b-info" title={`Pagado ${fmt_$(yaPagado)} de ${fmt_$(total)}`}>Parcial · {pct}%</span>
                        : <span className="badge b-warn">Pendiente</span>}
                    {esParcial && (
                      <div style={{fontSize:9,color:"var(--muted2)",marginTop:3}}>
                        {fmt_$(yaPagado)} de {fmt_$(total)} · Resta {fmt_$(pendiente)}
                      </div>
                    )}
                  </td>
                  <td>
                    {esDueno && !pagado && (
                      <button className="btn btn-success btn-sm" onClick={() => abrirPagoSueldo(emp, nov, liq)}>Pagar</button>
                    )}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
          </div>
          <div style={{padding:"12px 16px",borderTop:"1px solid var(--bd)",display:"flex",justifyContent:"flex-end",fontSize:12}}>
            <span>Total mes: <strong style={{color:"var(--success)"}}>{fmt_$(totalGeneral)}</strong></span>
          </div>
        </div>
      </>)}

      {pagoModal && (() => {
        const { emp, nov, liq } = pagoModal;
        const total = Math.round(Number(liq.total_a_pagar || 0));
        const yaPagado = Math.round(Number(liq.pagos_realizados || 0));
        const pendiente = Math.max(0, total - yaPagado);
        const totalAdelantos = Math.round((adelantosPendientes || []).reduce((s: number, a: any) => s + Number(a.monto), 0));
        const asignadoCash = Math.round(formasPago.reduce((s, f) => s + (parseFloat(f.monto) || 0), 0));
        const asignadoTotal = asignadoCash + totalAdelantos;
        const restanteTrasEste = pendiente - asignadoTotal;
        const completaPago = asignadoTotal >= pendiente;
        const esPagoParcial = asignadoTotal > 0 && asignadoTotal < pendiente;
        const puedeConfirmar = asignadoTotal > 0 && asignadoTotal <= pendiente && formasPago.every(f => parseFloat(f.monto) > 0);
        const cerrarModal = () => { setPagoModal(null); setFormasPago([]); setAdelantosPendientes([]); };

        const confirmarPago = async () => {
          if (!puedeConfirmar || pagando) return;
          setPagando(true);
          try {
            const desc = `${completaPago && yaPagado === 0 ? "Sueldo" : completaPago ? "Sueldo (saldo final)" : "Sueldo (parcial)"} ${emp.apellido} ${emp.nombre} - ${MESES_NOMBRE[pagoMes]} ${pagoAnio}`;

            for (const fp of formasPago) {
              const monto = parseFloat(fp.monto) || 0;
              if (monto <= 0) continue;
              if (emp.local_id) {
                const { data: caja } = await db.from("saldos_caja").select("saldo").eq("cuenta", fp.cuenta).eq("local_id", emp.local_id).maybeSingle();
                if (caja) await db.from("saldos_caja").update({ saldo: (caja.saldo || 0) - monto }).eq("cuenta", fp.cuenta).eq("local_id", emp.local_id);
              }
              await db.from("movimientos").insert([{
                id: genId("MOV"), fecha: toISO(today), cuenta: fp.cuenta,
                tipo: "Pago Sueldo", cat: "SUELDOS", importe: -monto, detalle: desc,
                local_id: emp.local_id,
              }]);
            }

            const nuevosPagos = yaPagado + asignadoTotal;
            const payload: any = { pagos_realizados: nuevosPagos };
            if (completaPago) {
              payload.estado = "pagado";
              payload.gasto_id = null;
              payload.pagado_at = new Date().toISOString();
              payload.pagado_por = user?.id;
            }

            if (liq._generated && nov?.id) {
              const { _novedadId, _generated, id: _ignoreId, pagos_realizados: _ignorePag, ...calcFields } = liq;
              await db.from("rrhh_liquidaciones").insert([{ novedad_id: nov.id, ...calcFields, estado: completaPago ? "pagado" : "pendiente", pagos_realizados: nuevosPagos, calculado_at: new Date().toISOString(), ...(completaPago ? { pagado_at: payload.pagado_at, pagado_por: user?.id } : {}) }]);
            } else {
              await db.from("rrhh_liquidaciones").update(payload).eq("id", liq.id);
            }

            if (adelantosPendientes && adelantosPendientes.length > 0) {
              await db.from("rrhh_adelantos")
                .update({ descontado: true })
                .in("id", adelantosPendientes.map((a: any) => a.id));
            }

            if (completaPago) {
              await db.from("rrhh_empleados").update({ aguinaldo_acumulado: (emp.aguinaldo_acumulado || 0) + total / 12 }).eq("id", emp.id);
              showToast("Pago completado");
            } else {
              showToast(`Pago parcial registrado — Resta ${fmt_$(restanteTrasEste)}`);
            }
            cerrarModal();
            await loadPagos();
            await loadEmpleados();
          } catch (err: any) {
            alert("Error: " + err.message);
          } finally {
            setPagando(false);
          }
        };

        return (
          <div className="overlay" onClick={cerrarModal}>
            <div className="modal" style={{width:480}} onClick={e => e.stopPropagation()}>
              <div className="modal-hd">
                <div className="modal-title">Pagar — {emp.apellido}, {emp.nombre}</div>
                <button className="close-btn" onClick={cerrarModal}>✕</button>
              </div>
              <div className="modal-body">
                <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",marginBottom:yaPagado>0?8:16,borderBottom:"1px solid var(--bd)"}}>
                  <span style={{fontSize:12,color:"var(--muted2)"}}>Total a pagar</span>
                  <span style={{fontSize:16,fontWeight:500,color:"var(--acc)"}}>{fmt_$(total)}</span>
                </div>

                {yaPagado > 0 && (
                  <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",marginBottom:12,fontSize:12}}>
                    <span style={{color:"var(--muted2)"}}>Ya pagado (parcial previo)</span>
                    <span style={{color:"var(--info)"}}>{fmt_$(yaPagado)} — Pendiente: <strong>{fmt_$(pendiente)}</strong></span>
                  </div>
                )}

                {totalAdelantos > 0 && (
                  <div style={{background:"var(--s2)",borderRadius:"var(--r)",padding:12,marginBottom:12}}>
                    <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Adelantos a descontar</div>
                    {adelantosPendientes.map((a: any) => (
                      <div key={a.id} style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:4}}>
                        <span style={{color:"var(--muted2)"}}>{fmt_d(a.fecha)} · {a.cuenta || "—"}</span>
                        <span style={{color:"var(--danger)"}}>−{fmt_$(a.monto)}</span>
                      </div>
                    ))}
                    <div style={{display:"flex",justifyContent:"space-between",marginTop:6,paddingTop:8,borderTop:"1px solid var(--bd)",fontSize:12,fontWeight:500}}>
                      <span>Total adelantos</span>
                      <span style={{color:"var(--danger)"}}>−{fmt_$(totalAdelantos)}</span>
                    </div>
                    <div style={{fontSize:10,color:"var(--muted2)",marginTop:4}}>
                      Ya salieron de caja al registrarse. Se marcarán como descontados al confirmar.
                    </div>
                  </div>
                )}

                {formasPago.map((fp, i) => (
                  <div key={i} style={{display:"flex",gap:8,marginBottom:8,alignItems:"center"}}>
                    <select className="search" style={{flex:1}} value={fp.cuenta}
                      onChange={e => setFormasPago(prev => prev.map((f, j) => j === i ? { ...f, cuenta: e.target.value } : f))}>
                      {CUENTAS_PAGO.map(c => <option key={c}>{c}</option>)}
                    </select>
                    <input type="number" className="search" style={{width:120}} placeholder="Monto" value={fp.monto}
                      onChange={e => setFormasPago(prev => prev.map((f, j) => j === i ? { ...f, monto: e.target.value } : f))} />
                    <button className="btn btn-danger btn-sm" onClick={() => setFormasPago(prev => prev.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}

                <button className="btn btn-ghost btn-sm" style={{marginBottom:16}}
                  onClick={() => setFormasPago(prev => [...prev, { cuenta: "Caja Efectivo", monto: restanteTrasEste > 0 ? String(restanteTrasEste) : "" }])}>
                  + Agregar forma de pago
                </button>

                {totalAdelantos > 0 && (
                  <>
                    <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:11}}>
                      <span style={{color:"var(--muted2)"}}>Efectivo en caja</span>
                      <span style={{color:"var(--txt)"}}>{fmt_$(asignadoCash)}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:11}}>
                      <span style={{color:"var(--muted2)"}}>+ Adelantos a imputar</span>
                      <span style={{color:"var(--txt)"}}>{fmt_$(totalAdelantos)}</span>
                    </div>
                  </>
                )}

                <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderTop:"1px solid var(--bd)"}}>
                  <span style={{fontSize:12,color: esPagoParcial ? "var(--warn)" : "var(--muted2)"}}>
                    {esPagoParcial ? "Pago parcial — Restante" : "Restante"}
                  </span>
                  <span style={{fontSize:14,fontWeight:500,color: Math.abs(restanteTrasEste) < 0.01 ? "var(--success)" : restanteTrasEste < 0 ? "var(--danger)" : "var(--warn)"}}>
                    {fmt_$(Math.max(0, restanteTrasEste))}
                  </span>
                </div>
              </div>
              <div className="modal-ft">
                <button className="btn btn-sec" onClick={cerrarModal}>Cancelar</button>
                <button className="btn btn-success" onClick={confirmarPago} disabled={!puedeConfirmar || pagando}>
                  {pagando ? "Procesando..." : completaPago ? "Confirmar pago" : "Registrar pago parcial"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {adelModal && (
        <div className="overlay" onClick={() => setAdelModal(false)}>
          <div className="modal" style={{width:480}} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Adelanto a empleado</div>
              <button className="close-btn" onClick={() => setAdelModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field"><label>Empleado</label>
                <select value={adelForm.empleado_id} onChange={e => setAdelForm({...adelForm, empleado_id: e.target.value})}>
                  <option value="">Seleccionar...</option>
                  {(allEmps || [])
                    .filter(e => e.activo !== false)
                    .filter(e => !pagoLocal || e.local_id === parseInt(String(pagoLocal)))
                    .map(e => <option key={e.id} value={e.id}>{e.apellido}, {e.nombre}</option>)}
                </select>
              </div>
              <div className="form2">
                <div className="field"><label>Monto $</label>
                  <input type="number" value={adelForm.monto} onChange={e => setAdelForm({...adelForm, monto: e.target.value})} placeholder="0"/>
                </div>
                <div className="field"><label>Fecha</label>
                  <input type="date" value={adelForm.fecha} onChange={e => setAdelForm({...adelForm, fecha: e.target.value})}/>
                </div>
              </div>
              <div className="field"><label>Cuenta de egreso</label>
                <select value={adelForm.cuenta} onChange={e => setAdelForm({...adelForm, cuenta: e.target.value})}>
                  {CUENTAS_PAGO.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="field"><label>Descripción (opcional)</label>
                <input value={adelForm.descripcion} onChange={e => setAdelForm({...adelForm, descripcion: e.target.value})} placeholder="Ej: Adelanto solicitado por urgencia..."/>
              </div>
              <div style={{fontSize:10,color:"var(--muted2)",marginTop:4}}>
                Se registra como movimiento (cat SUELDOS), afecta saldos de caja y queda como adelanto descontable a futuro.
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setAdelModal(false)}>Cancelar</button>
              <button className="btn btn-acc" onClick={guardarAdelanto} disabled={!adelForm.empleado_id || !adelForm.monto || parseFloat(adelForm.monto) <= 0}>
                Registrar adelanto
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function TabHistorial({
  histMes, setHistMes, histAnio, setHistAnio, histLocal, setHistLocal,
  locsDisp, esEnc, histLoading, histData, histDetalle, setHistDetalle,
}: any) {
  return (
    <>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        <select className="search" style={{width:100}} value={histMes} onChange={e => setHistMes(parseInt(e.target.value))}>
          {MESES_SEL.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
        </select>
        <input type="number" className="search" style={{width:70}} value={histAnio} onChange={e => setHistAnio(parseInt(e.target.value))} />
        <select className="search" style={{width:160}} value={String(histLocal || "")} onChange={e => setHistLocal(e.target.value)}>
          {!esEnc && <option value="">Todos los locales</option>}
          {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
        </select>
      </div>
      {histLoading ? <div className="loading">Cargando...</div> : histData.length === 0 ? <div className="empty">Sin pagos en este período</div> : (
        <div className="panel">
          <table>
            <thead><tr><th>Fecha</th><th>Empleado</th><th>Puesto</th><th>Tipo</th><th style={{textAlign:"right"}}>Monto</th><th></th></tr></thead>
            <tbody>{histData.map((h, i) => (
              <tr key={i}>
                <td className="mono" style={{fontSize:11}}>{fmt_d(h.fecha)}</td>
                <td style={{fontWeight:500,fontSize:12}}>{h.emp?.apellido}, {h.emp?.nombre}</td>
                <td><span className="badge b-muted" style={{fontSize:8}}>{h.emp?.puesto}</span></td>
                <td><span className="badge b-info" style={{fontSize:9}}>{h.label}</span></td>
                <td style={{textAlign:"right"}}><span className="num kpi-success">{fmt_$(h.monto)}</span></td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => setHistDetalle(h)}>Ver</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {histDetalle && (
        <div className="overlay" onClick={() => setHistDetalle(null)}>
          <div className="modal" style={{width:520}} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">{histDetalle.label} — {histDetalle.emp?.apellido}, {histDetalle.emp?.nombre}</div>
              <button className="close-btn" onClick={() => setHistDetalle(null)}>✕</button>
            </div>
            <div className="modal-body">
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
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={() => setHistDetalle(null)}>Cerrar</button></div>
          </div>
        </div>
      )}
    </>
  );
}
