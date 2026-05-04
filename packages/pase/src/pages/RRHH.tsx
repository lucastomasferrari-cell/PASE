import { useState, useEffect, useRef } from "react";
import { db } from "../lib/supabase";
import { localesVisibles, applyLocalScope, cuentasVisibles } from "../lib/auth";
import { translateRpcError } from "../lib/errors";
import { toISO, today, fmt_d, fmt_$ } from "../lib/utils";
import {
  calcularVacaciones,
  calcularSACProporcional,
  calcularTotalLiquidacion,
} from "../lib/calculos/rrhh";
import RRHHLegajo from "./RRHHLegajo";
import type { Usuario, Local } from "../types";
import type {
  Empleado, Novedad, Liquidacion, PagoEspecial,
  ValorDoble, Adelanto, LineaPago,
} from "../types/rrhh";

interface RRHHProps {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

// Estructura del state empForm (form de creación/edición de empleado).
// Difiere de Empleado en que sueldo_mensual y local_id vienen como string
// desde el input (parsean al guardar).
interface EmpForm {
  local_id: string;
  apellido: string;
  nombre: string;
  cuil: string;
  puesto: string;
  sueldo_mensual: string;
  alias_mp: string;
  fecha_inicio: string;
  activo: boolean;
}

// State de empModal: null cuando cerrado, "new" cuando agregando nuevo,
// Empleado cuando editando uno existente.
type EmpModalState = Empleado | "new" | null;

// State de novMap: map de empleado_id → novedad parcial editable. Difiere de
// Novedad porque los campos opcionales pueden estar undefined antes del
// confirmar y porque guardamos id si ya está persistida.
interface NovedadEditable extends Partial<Novedad> {
  fecha_inicio_mes?: string | null;
}

// Liquidación posiblemente generada en frontend (sin persistir todavía).
// Los flags _generated, _novedadId se usan en pagar_sueldo RPC para que
// la función SQL la cree on-the-fly con p_calc.
interface LiquidacionConGenerated extends Partial<Liquidacion> {
  _generated?: boolean;
  _novedadId?: string;
}

// Fila del array pagoData — combina empleado, novedad confirmada y liquidación
// (pre-generada o persistida).
interface PagoDataRow {
  emp: Empleado;
  nov: Novedad;
  liq: LiquidacionConGenerated;
}

// State del form de adelanto.
interface AdelantoForm {
  empleado_id: string;
  monto: string;
  cuenta: string;
  fecha: string;
  descripcion: string;
}

// Stats del Dashboard (calculadas en loadDashboard).
interface DashStats {
  total: number;
  sinDatos: number;
  conNovedades: number;
  confirmadas: number;
  pagados: number;
  estimado: number;
  totalSAC: number;
  proxSAC: string;
  diasSAC: number;
  diasFinMes: number;
  mes: number;
  anio: number;
}

// Empleado info devuelto por joins de rrhh_pagos_especiales / rrhh_adelantos /
// rrhh_novedades→rrhh_empleados (mismo subset en todas).
interface EmpleadoMin {
  nombre: string;
  apellido: string;
  puesto: string;
  local_id: number;
}

// Novedad como viene del join de la query de Historial.
interface NovedadHist extends Pick<Novedad, "mes" | "anio" | "empleado_id" | "inasistencias" | "presentismo" | "horas_extras" | "dobles" | "feriados" | "adelantos" | "observaciones"> {
  rrhh_empleados: EmpleadoMin | null;
}

// Liquidación como viene del join.
interface LiquidacionConNovedadHist extends Liquidacion {
  rrhh_novedades: NovedadHist | null;
}

// Pago especial con join al empleado.
interface PagoEspecialConEmpleado extends PagoEspecial {
  rrhh_empleados: EmpleadoMin | null;
}

// Adelanto con join al empleado.
interface AdelantoConEmpleado extends Adelanto {
  rrhh_empleados: EmpleadoMin | null;
}

// Fila normalizada del array histData. Union de los 3 tipos de pagos
// (sueldo, especial, adelanto) con sus campos comunes + detalle.
interface HistRow {
  tipo: string;
  fecha: string | null | undefined;
  emp: EmpleadoMin | null;
  nov?: NovedadHist | null;
  liq?: LiquidacionConNovedadHist;
  monto: number;
  label: string;
  detalle?: PagoEspecialConEmpleado | AdelantoConEmpleado;
}

// Liquidación con efectivo/transferencia computados (lo que devuelve
// calcLiquidacion). Compatible con Liquidacion completa pero parcial porque
// no incluye id, novedad_id, etc. — el RPC los pone al persistir.
type LiquidacionCalculada = ReturnType<typeof calcularTotalLiquidacion> & {
  efectivo: number;
  transferencia: number;
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function calcLiquidacion(emp: Empleado, nov: NovedadEditable, valorDoble: number): LiquidacionCalculada {
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

const inp: React.CSSProperties = { padding:"3px 5px", background:"var(--bg)", border:"1px solid var(--bd)", color:"var(--txt)", fontFamily:"'DM Mono',monospace", fontSize:10, borderRadius:"var(--r)", textAlign:"center" };

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function RRHH({ user, locales, localActivo }: RRHHProps) {
  const visCuentas = cuentasVisibles(user);
  const cuentasUsables = visCuentas === null ? CUENTAS_PAGO : CUENTAS_PAGO.filter(c => visCuentas.includes(c));
  const [tab, setTab] = useState("dashboard");
  const [legajoId, setLegajoId] = useState<string | null>(null);
  const [cfgModal, setCfgModal] = useState(false);
  const [toast, setToast] = useState("");
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(""), 3000); };

  const visLocs = localesVisibles(user);
  const locsDisp = visLocs === null ? locales : locales.filter((l: Local) => visLocs.includes(l.id));
  const esEnc = user?.rol === "encargado";
  const esDueno = user?.rol === "dueno" || user?.rol === "admin";
  // Default explícito a "" en vez de undefined cuando no hay match — los
  // selects luego usan String(...) y los handlers aceptan string vacío.
  const defaultLocal: string | number = localActivo
    || (locsDisp.length === 1 ? (locsDisp[0]?.id ?? "") : (esEnc && locsDisp.length ? (locsDisp[0]?.id ?? "") : ""));

  // ─── SHARED STATE ──────────────────────────────────────────────────────────
  const [allEmps, setAllEmps] = useState<Empleado[]>([]);
  const [valoresDoble, setValoresDoble] = useState<ValorDoble[]>([]);
  const [empSearch, setEmpSearch] = useState("");
  const [vacTomadas, setVacTomadas] = useState<Record<string, number>>({});
  const [empFiltLocal, setEmpFiltLocal] = useState(defaultLocal);
  // BUG 2: por defecto solo mostramos empleados activos. Toggle para incluir inactivos.
  const [empMostrarInactivos, setEmpMostrarInactivos] = useState(false);
  const [empModal, setEmpModal] = useState<EmpModalState>(null);
  const empEmpty: EmpForm = { local_id:"", apellido:"", nombre:"", cuil:"", puesto:"", sueldo_mensual:"", alias_mp:"", fecha_inicio:"", activo:true };
  const [empForm, setEmpForm] = useState<EmpForm>(empEmpty);

  // Novedades
  const [novMes, setNovMes] = useState(today.getMonth() + 1);
  const [novAnio, setNovAnio] = useState(today.getFullYear());
  const [novLocal, setNovLocal] = useState(defaultLocal);
  const [novLocalTouched, setNovLocalTouched] = useState(false);
  const [novEmps, setNovEmps] = useState<Empleado[]>([]);
  const [novMap, setNovMap] = useState<Record<string, NovedadEditable>>({});
  const [novLoading, setNovLoading] = useState(false);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Pagos
  const [pagoMes, setPagoMes] = useState(today.getMonth() + 1);
  const [pagoAnio, setPagoAnio] = useState(today.getFullYear());
  const [pagoLocal, setPagoLocal] = useState(defaultLocal);
  const [pagoLocalTouched, setPagoLocalTouched] = useState(false);
  const [pagoData, setPagoData] = useState<PagoDataRow[]>([]);
  // Si se dispara "Pagar" desde el legajo, guardamos el emp.id acá para abrir
  // el modal automáticamente cuando loadPagos termine y la fila esté en pagoData.
  const [pendingPagoEmpId, setPendingPagoEmpId] = useState<string | null>(null);
  const [pagoLoading, setPagoLoading] = useState(false);
  const [pagando, setPagando] = useState(false);
  const [pagoModal, setPagoModal] = useState<PagoDataRow | null>(null);
  const [formasPago, setFormasPago] = useState<LineaPago[]>([]);
  const [adelantosPendientes, setAdelantosPendientes] = useState<Adelanto[]>([]);
  const [adelModal, setAdelModal] = useState(false);
  const [adelForm, setAdelForm] = useState<AdelantoForm>({ empleado_id:"", monto:"", cuenta:"Caja Efectivo", fecha:toISO(today), descripcion:"" });

  // Dashboard
  const [dashLoading, setDashLoading] = useState(true);
  const [dashStats, setDashStats] = useState<DashStats | Record<string, never>>({});

  // Historial
  const [histLocal, setHistLocal] = useState(defaultLocal);
  const [histMes, setHistMes] = useState(today.getMonth() + 1);
  const [histAnio, setHistAnio] = useState(today.getFullYear());
  const [histData, setHistData] = useState<HistRow[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histDetalle, setHistDetalle] = useState<HistRow | null>(null);

  // Config — el valor se edita como string (input number) y se parsea al
  // guardar. Por eso tomamos los campos sin valor de ValorDoble y agregamos
  // valor: string | number explícito.
  const [cfgEdit, setCfgEdit] = useState<(Omit<ValorDoble, "valor"> & { valor: string | number }) | null>(null);

  // ─── LOAD FUNCTIONS ────────────────────────────────────────────────────────
  const loadValoresDoble = async () => {
    const { data } = await db.from("rrhh_valores_doble").select("*").order("puesto");
    setValoresDoble((data as ValorDoble[]) || []);
  };

  const loadEmpleados = async () => {
    let q = db.from("rrhh_empleados").select("*").order("apellido");
    q = applyLocalScope(q, user, localActivo);
    const { data } = await q;
    const emps = (data as Empleado[]) || [];
    setAllEmps(emps);
    // Cargar días de vacaciones tomadas (novedades confirmadas)
    const empIds = emps.map(e => e.id);
    if (empIds.length) {
      const { data: novs } = await db.from("rrhh_novedades").select("empleado_id, vacaciones_dias").eq("estado", "confirmado").in("empleado_id", empIds).gt("vacaciones_dias", 0);
      const map: Record<string, number> = {};
      (novs || []).forEach((n) => { map[n.empleado_id] = (map[n.empleado_id] || 0) + Number(n.vacaciones_dias || 0); });
      setVacTomadas(map);
    }
  };

  const loadNovedades = async () => {
    if (!novLocal) return;
    setNovLoading(true);
    const { data: emps } = await db.from("rrhh_empleados").select("*").eq("local_id", parseInt(String(novLocal))).eq("activo", true).order("apellido");
    const empleados = (emps as Empleado[]) || [];
    const empIds = empleados.map(e => e.id);
    let novs: Novedad[] = [];
    if (empIds.length) {
      const { data } = await db.from("rrhh_novedades").select("*").eq("mes", novMes).eq("anio", novAnio).in("empleado_id", empIds);
      novs = (data as Novedad[]) || [];
    }
    const map: Record<string, NovedadEditable> = {};
    empleados.forEach(e => {
      const existing = novs.find(n => n.empleado_id === e.id);
      map[e.id] = existing || {
        inasistencias: 0, presentismo: "MANTIENE", horas_extras: 0, dobles: 0,
        feriados: 0, adelantos: 0, vacaciones_dias: 0, fecha_inicio_mes: null,
        observaciones: "", estado: "borrador",
      };
    });
    setNovEmps(empleados);
    setNovMap(map);
    setNovLoading(false);
  };

  const loadPagos = async () => {
    if (!pagoLocal) return;
    setPagoLoading(true);

    const { data: emps } = await db.from("rrhh_empleados")
      .select("*").eq("local_id", parseInt(String(pagoLocal))).eq("activo", true).order("apellido");
    const empleados = (emps as Empleado[]) || [];
    const empIds = empleados.map(e => e.id);

    if (!empIds.length) { setPagoData([]); setPagoLoading(false); return; }

    const { data: novs } = await db.from("rrhh_novedades")
      .select("*")
      .eq("mes", pagoMes).eq("anio", pagoAnio)
      .eq("estado", "confirmado")
      .in("empleado_id", empIds);
    const novedades = (novs as Novedad[]) || [];

    const novIds = novedades.map(n => n.id).filter((id): id is string => !!id);

    // Query separada para liquidaciones (evita problemas con nested select y FK)
    let liqs: Liquidacion[] = [];
    if (novIds.length) {
      const { data } = await db.from("rrhh_liquidaciones")
        .select("*").in("novedad_id", novIds);
      liqs = (data as Liquidacion[]) || [];
    }

    const merged: PagoDataRow[] = empleados.flatMap((emp) => {
      const nov = novedades.find(n => n.empleado_id === emp.id);
      if (!nov) return [];
      const persisted = liqs.find(l => l.novedad_id === nov.id);
      let liq: LiquidacionConGenerated;
      if (persisted) {
        liq = persisted;
      } else {
        const vd = valoresDoble.find(v => v.puesto === emp.puesto)?.valor || 0;
        const calc = calcLiquidacion(emp, nov, vd);
        liq = { ...calc, total_a_pagar: Math.round(calc.total_a_pagar), estado: "pendiente", _novedadId: nov.id, _generated: true };
      }
      return [{ emp, nov, liq }];
    });

    setPagoData(merged);
    setPagoLoading(false);
  };

  const loadDashboard = async () => {
    setDashLoading(true);
    let empQ = db.from("rrhh_empleados").select("*").eq("activo", true);
    empQ = applyLocalScope(empQ, user, localActivo);
    const { data: emps } = await empQ;
    const activos = emps || [];
    const mes = today.getMonth() + 1;
    const anio = today.getFullYear();
    const empIds = activos.map(e => e.id);
    let novsMes: Novedad[] = [];
    if (empIds.length) {
      const { data } = await db.from("rrhh_novedades").select("*, rrhh_liquidaciones(*)").eq("mes", mes).eq("anio", anio).in("empleado_id", empIds);
      novsMes = (data as Novedad[]) || [];
    }
    const sinDatos = activos.filter(e =>
      !e.cuil || !e.fecha_inicio || !e.sueldo_mensual || e.sueldo_mensual <= 0
    ).length;
    const conNovedades = novsMes.length;
    const confirmadas = novsMes.filter(n => n.estado === "confirmado").length;
    const novIds = novsMes.map(n => n.id).filter((id): id is string => !!id);
    let liqsDash: Pick<Liquidacion, "novedad_id" | "estado" | "total_a_pagar">[] = [];
    if (novIds.length) {
      const { data: liqData } = await db.from("rrhh_liquidaciones")
        .select("novedad_id, estado, total_a_pagar")
        .in("novedad_id", novIds);
      liqsDash = (liqData as Pick<Liquidacion, "novedad_id" | "estado" | "total_a_pagar">[]) || [];
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

    // Casts a unknown primero porque Supabase tipa nested FK como array
    // — ver convención en types/rrhh.ts.
    const liqRows = ((liqs as unknown) as LiquidacionConNovedadHist[]) || [];
    const espRows = ((especiales as unknown) as PagoEspecialConEmpleado[]) || [];
    const adelRows = ((adelantos as unknown) as AdelantoConEmpleado[]) || [];

    const sueldos: HistRow[] = liqRows.map(l => ({
      tipo: "sueldo",
      fecha: l.pagado_at?.split("T")[0],
      emp: l.rrhh_novedades?.rrhh_empleados ?? null,
      nov: l.rrhh_novedades,
      liq: l,
      monto: l.total_a_pagar,
      label: `Sueldo ${MESES_NOMBRE[l.rrhh_novedades?.mes || 0]} ${l.rrhh_novedades?.anio || ""}`,
    }));

    const esp: HistRow[] = espRows.map(e => ({
      tipo: e.tipo,
      fecha: e.pagado_at?.split("T")[0],
      emp: e.rrhh_empleados,
      monto: Number(e.monto_pagado) > 0 ? Number(e.monto_pagado) : Number(e.monto),
      label: (e.tipo === "vacaciones" ? "Vacaciones" : e.tipo === "aguinaldo" ? "Aguinaldo" : "Liquidación final") + (e.pendiente ? " (parcial)" : ""),
      detalle: e,
    }));

    const adel: HistRow[] = adelRows.map(a => ({
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

  // Patrones fetch-on-mount / fetch-on-dep-change. Las funciones loadX
  // hacen setState async post-fetch — agregarlas a deps causaría re-fetch
  // infinito (se recrean cada render).
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { loadValoresDoble(); loadEmpleados(); }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { if (tab === "dashboard") loadDashboard(); }, [tab]);
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { if (tab === "novedades" && novLocal) loadNovedades(); }, [tab, novLocal, novMes, novAnio]);
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { if (tab === "pagos" && pagoLocal) loadPagos(); }, [tab, pagoLocal, pagoMes, pagoAnio]);
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { if (tab === "historial") loadHistorial(); }, [tab, histLocal, histMes, histAnio]);

  // Autoselección de local en Novedades/Pagos.
  // Prioridad: localActivo (sidebar) > único local disponible (encargado o locsDisp.length===1) > vacío.
  // - Al entrar al tab: reset flag tocadoManual y apply default actual.
  // - Mientras está en el tab, si localActivo cambia y el usuario no tocó manualmente: sync.
  // - Si tocó manualmente: respetar hasta que cambie de tab y vuelva.
  const lidDefault = (): string => {
    if (localActivo) return String(localActivo);
    if (locsDisp.length === 1) return String(locsDisp[0]?.id ?? "");
    if (esEnc && locsDisp.length) return String(locsDisp[0]?.id ?? "");
    return "";
  };
  // Reset + aplicar default al entrar al tab. lidDefault depende de
  // localActivo/locsDisp/esEnc — todos prop-derived. Adding lidDefault a
  // deps re-fire si la fn ref cambia (cada render). Disable.
  useEffect(() => {
    if (tab === "novedades") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNovLocalTouched(false);
      const v = lidDefault();
      if (v) setNovLocal(v);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  useEffect(() => {
    if (tab === "pagos") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPagoLocalTouched(false);
      const v = lidDefault();
      if (v) setPagoLocal(v);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  // Sync con localActivo o locales mientras está en el tab (si no se tocó)
  useEffect(() => {
    if (tab === "novedades" && !novLocalTouched) {
      const v = lidDefault();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (v) setNovLocal(v);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localActivo, locsDisp.length, locsDisp[0]?.id]);
  useEffect(() => {
    if (tab === "pagos" && !pagoLocalTouched) {
      const v = lidDefault();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (v) setPagoLocal(v);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localActivo, locsDisp.length, locsDisp[0]?.id]);
  const handleNovLocalChange = (v: string) => { setNovLocal(v); setNovLocalTouched(true); };
  const handlePagoLocalChange = (v: string) => { setPagoLocal(v); setPagoLocalTouched(true); };

  // Puente legajo → tab Pagos: al hacer click en "Pagar" desde la tabla de
  // movimientos del legajo, cerramos el modal, cambiamos al tab Pagos y
  // prefiltramos local/mes/anio. El useEffect de abajo abre el modal de pago
  // cuando pagoData se carga con la fila del empleado.
  const goToPagoFromLegajo = (emp: Empleado, nov: Novedad) => {
    setLegajoId(null);
    setTab("pagos");
    if (emp.local_id) {
      setPagoLocal(String(emp.local_id));
      setPagoLocalTouched(true);
    }
    if (nov?.mes) setPagoMes(Number(nov.mes));
    if (nov?.anio) setPagoAnio(Number(nov.anio));
    setPendingPagoEmpId(emp.id);
  };

  // ─── EMPLEADOS ACTIONS ─────────────────────────────────────────────────────
  const puestos = [...new Set(valoresDoble.map(v => v.puesto))];
  const empsFilt = allEmps.filter(e => {
    if (!empMostrarInactivos && e.activo === false) return false;
    if (empFiltLocal && e.local_id !== parseInt(String(empFiltLocal))) return false;
    if (empSearch && !(`${e.apellido} ${e.nombre}`).toLowerCase().includes(empSearch.toLowerCase())) return false;
    return true;
  });

  const guardarEmp = async () => {
    if (!empForm.apellido || !empForm.nombre || !empForm.local_id || !empForm.puesto || !empForm.sueldo_mensual || !empForm.fecha_inicio) return;
    const payload = { ...empForm, local_id: parseInt(empForm.local_id), sueldo_mensual: parseFloat(empForm.sueldo_mensual) || 0 };
    // Estrechar empModal: si tiene .id (no es "new" ni null), es Empleado.
    const existing = empModal && empModal !== "new" ? empModal : null;
    if (existing) {
      const sueldoAnt = Number(existing.sueldo_mensual);
      if (sueldoAnt !== payload.sueldo_mensual && sueldoAnt > 0) {
        await db.from("rrhh_historial_sueldos").insert([{
          empleado_id: existing.id, sueldo_anterior: sueldoAnt, sueldo_nuevo: payload.sueldo_mensual,
          motivo: "Edición desde listado", registrado_por: user?.id,
        }]);
      }
      // Strip de campos calculados/derivados que no van al UPDATE; los nombres
      // documentan qué se descarta (más legible que renombrar a `_x`).
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { valor_dia, valor_hora, creado_at, vacaciones_dias_acumulados, aguinaldo_acumulado, fecha_egreso, motivo_baja, ...upd } = payload as Partial<Empleado> & Record<string, unknown>;
      await db.from("rrhh_empleados").update(upd).eq("id", existing.id);
    } else {
      await db.from("rrhh_empleados").insert([payload]);
    }
    setEmpModal(null); loadEmpleados();
  };

  const abrirEmpNuevo = () => { setEmpForm({ ...empEmpty, local_id: empFiltLocal ? String(empFiltLocal) : "" }); setEmpModal("new"); };
  const abrirEmpEditar = (e: Empleado) => {
    setEmpForm({ local_id: e.local_id ? String(e.local_id) : "", apellido:e.apellido, nombre:e.nombre, cuil:e.cuil||"", puesto:e.puesto, sueldo_mensual:String(e.sueldo_mensual), alias_mp:e.alias_mp||"", fecha_inicio:e.fecha_inicio||"", activo:e.activo });
    setEmpModal(e);
  };

  // ─── NOVEDADES ACTIONS ─────────────────────────────────────────────────────
  const updateNov = (empId: string, field: keyof NovedadEditable, value: string | number) => {
    setNovMap(prev => {
      const nextNov: NovedadEditable = { ...prev[empId], [field]: value };
      const updated = { ...prev, [empId]: nextNov };
      if (saveTimers.current[empId]) clearTimeout(saveTimers.current[empId]);
      saveTimers.current[empId] = setTimeout(() => saveNovedad(empId, nextNov), 800);
      return updated;
    });
  };

  const saveNovedad = async (empId: string, nov: NovedadEditable) => {
    const { id, estado, vacaciones_dias: _vac, ...rest } = nov;
    await db.from("rrhh_novedades").upsert({
      ...(id ? { id } : {}), empleado_id: empId, mes: novMes, anio: novAnio,
      ...rest, estado: estado || "borrador", cargado_por: user?.id, updated_at: new Date().toISOString(),
    }, { onConflict: "empleado_id,mes,anio" });
  };

  const confirmarUno = async (emp: Empleado) => {
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

  // BUG 4: bulk-confirmar todos los empleados en borrador. Cierra de un tirón
  // las novedades del mes y crea las liquidaciones (estado "pendiente"), que
  // es el equivalente a "listo para pago".
  const confirmarTodas = async () => {
    const enBorrador = novEmps.filter(e => (novMap[e.id]?.estado ?? "borrador") !== "confirmado");
    if (enBorrador.length === 0) { showToast("Todas ya están confirmadas"); return; }
    if (!confirm(`Confirmar novedades de ${enBorrador.length} empleado${enBorrador.length > 1 ? "s" : ""}? Pasan a estado "listo para pago".`)) return;
    // Flush autosaves pendientes para no pisar el confirmar.
    Object.values(saveTimers.current).forEach(t => clearTimeout(t));
    for (const emp of enBorrador) await confirmarUno(emp);
    showToast(`${enBorrador.length} novedad${enBorrador.length > 1 ? "es" : ""} confirmada${enBorrador.length > 1 ? "s" : ""} → listo para pago`);
  };

  // ─── ADELANTOS ─────────────────────────────────────────────────────────────
  // Si hay un pendingPagoEmpId (viene del legajo) y pagoData ya contiene
  // esa fila, abrir el modal de pago con los datos correctos.
  useEffect(() => {
    if (!pendingPagoEmpId || !pagoData.length) return;
    const row = pagoData.find(r => r.emp?.id === pendingPagoEmpId);
    if (row && row.liq && row.liq.estado !== "pagado") {
      // TODO(lint-cleanup): abrirPagoSueldo se declara abajo (l.499). Patrón
      // efecto-llama-función-declarada-luego — funciona en runtime porque el
      // efecto corre post-render. Reordenar implica mover ~50 líneas en flow
      // de pagos críticos — PR dedicado.
      // eslint-disable-next-line react-hooks/immutability
      abrirPagoSueldo(row.emp, row.nov, row.liq);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingPagoEmpId(null);
  }, [pagoData, pendingPagoEmpId]);

  const abrirPagoSueldo = async (emp: Empleado, nov: Novedad, liq: LiquidacionConGenerated) => {
    const { data: adelantos } = await db.from("rrhh_adelantos")
      .select("*")
      .eq("empleado_id", emp.id)
      .eq("descontado", false)
      .order("fecha");
    const pendientes = (adelantos as Adelanto[]) || [];
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
    const { error } = await db.rpc("registrar_adelanto", {
      p_empleado_id: adelForm.empleado_id,
      p_monto: monto,
      p_cuenta: adelForm.cuenta,
      p_fecha: adelForm.fecha,
      p_detalle: adelForm.descripcion || null,
    });
    if (error) { alert(translateRpcError(error)); return; }

    showToast(`Adelanto registrado — ${emp.apellido}`);
    setAdelModal(false);
    setAdelForm({ empleado_id:"", monto:"", cuenta:"Caja Efectivo", fecha:toISO(today), descripcion:"" });
    if (tab === "pagos") await loadPagos();
  };

  // ─── CONFIG ACTIONS ────────────────────────────────────────────────────────
  const guardarValorDoble = async (item: Omit<ValorDoble, "valor"> & { valor: string | number }) => {
    if (!item.puesto || !item.valor) return;
    await db.from("rrhh_valores_doble").upsert({ ...item, valor: parseFloat(String(item.valor)), updated_at: new Date().toISOString() }, { onConflict: "puesto" });
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
          empMostrarInactivos={empMostrarInactivos}
          setEmpMostrarInactivos={setEmpMostrarInactivos}
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
          setNovLocal={handleNovLocalChange}
          locsDisp={locsDisp}
          novLoading={novLoading}
          novEmps={novEmps}
          novMap={novMap}
          valoresDoble={valoresDoble}
          updateNov={updateNov}
          confirmarUno={confirmarUno}
          confirmarTodas={confirmarTodas}
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
          setPagoLocal={handlePagoLocalChange}
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
          allEmps={allEmps}
          adelModal={adelModal}
          setAdelModal={setAdelModal}
          adelForm={adelForm}
          setAdelForm={setAdelForm}
          guardarAdelanto={guardarAdelanto}
          adelantosPendientes={adelantosPendientes}
          setAdelantosPendientes={setAdelantosPendientes}
          abrirPagoSueldo={abrirPagoSueldo}
          cuentasUsables={cuentasUsables}
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
              <RRHHLegajo empleadoId={legajoId} user={user} locales={locales} onClose={() => { setLegajoId(null); loadEmpleados(); }} onGoToPago={goToPagoFromLegajo} />
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

function TabDashboard({ dashStats, dashLoading }: { dashStats: DashStats | Record<string, never>; dashLoading: boolean }) {
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
}

function TabEmpleados({
  empFiltLocal, setEmpFiltLocal, empSearch, setEmpSearch,
  empMostrarInactivos, setEmpMostrarInactivos,
  esEnc, locsDisp, locales, empsFilt, vacTomadas, puestos,
  empModal, setEmpModal, empForm, setEmpForm,
  abrirEmpNuevo, abrirEmpEditar, guardarEmp, setLegajoId,
}: TabEmpleadosProps) {
  return (
    <>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        <select className="search" style={{width:160}} value={empFiltLocal} onChange={e => setEmpFiltLocal(e.target.value)}>
          {!esEnc && <option value="">Todos los locales</option>}
          {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
        </select>
        <input className="search" placeholder="Buscar..." value={empSearch} onChange={e => setEmpSearch(e.target.value)} style={{width:160}} />
        <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"var(--muted2)",cursor:"pointer"}}>
          <input type="checkbox" checked={empMostrarInactivos} onChange={e => setEmpMostrarInactivos(e.target.checked)} />
          Mostrar inactivos
        </label>
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
  valoresDoble: ValorDoble[];
  updateNov: (empId: string, field: keyof NovedadEditable, value: string | number) => void;
  confirmarUno: (emp: Empleado) => Promise<void>;
  confirmarTodas: () => Promise<void>;
  editarNov: (empId: string) => Promise<void>;
  esDueno: boolean;
}

function TabNovedades({
  novMes, setNovMes, novAnio, setNovAnio, novLocal, setNovLocal,
  locsDisp, novLoading, novEmps, novMap, valoresDoble,
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

interface TabPagosProps {
  pagoMes: number;
  setPagoMes: React.Dispatch<React.SetStateAction<number>>;
  pagoAnio: number;
  setPagoAnio: React.Dispatch<React.SetStateAction<number>>;
  pagoLocal: string | number;
  setPagoLocal: (v: string) => void;
  locsDisp: Local[];
  esEnc: boolean;
  esDueno: boolean;
  pagoLoading: boolean;
  pagoData: PagoDataRow[];
  totalPagosPend: number;
  totalGeneral: number;
  pagoModal: PagoDataRow | null;
  setPagoModal: React.Dispatch<React.SetStateAction<PagoDataRow | null>>;
  formasPago: LineaPago[];
  setFormasPago: React.Dispatch<React.SetStateAction<LineaPago[]>>;
  pagando: boolean;
  setPagando: React.Dispatch<React.SetStateAction<boolean>>;
  loadPagos: () => Promise<void>;
  loadEmpleados: () => Promise<void>;
  showToast: (m: string) => void;
  allEmps: Empleado[];
  adelModal: boolean;
  setAdelModal: React.Dispatch<React.SetStateAction<boolean>>;
  adelForm: AdelantoForm;
  setAdelForm: React.Dispatch<React.SetStateAction<AdelantoForm>>;
  guardarAdelanto: () => Promise<void>;
  adelantosPendientes: Adelanto[];
  setAdelantosPendientes: React.Dispatch<React.SetStateAction<Adelanto[]>>;
  abrirPagoSueldo: (emp: Empleado, nov: Novedad, liq: LiquidacionConGenerated) => Promise<void>;
  cuentasUsables: string[];
}

function TabPagos({
  pagoMes, setPagoMes, pagoAnio, setPagoAnio, pagoLocal, setPagoLocal,
  locsDisp, esEnc, esDueno, pagoLoading, pagoData,
  totalPagosPend, totalGeneral,
  pagoModal, setPagoModal, formasPago, setFormasPago,
  pagando, setPagando, loadPagos, loadEmpleados, showToast,
  allEmps, adelModal, setAdelModal, adelForm, setAdelForm, guardarAdelanto,
  adelantosPendientes, setAdelantosPendientes, abrirPagoSueldo,
  cuentasUsables,
}: TabPagosProps) {
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
            <tbody>{pagoData.map(row => {
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
        const totalAdelantos = Math.round((adelantosPendientes || []).reduce((s, a) => s + Number(a.monto), 0));
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
            // Serializar las formas de pago (sólo las con monto > 0).
            const formasValidas = formasPago
              .filter(fp => (parseFloat(fp.monto) || 0) > 0)
              .map(fp => ({ cuenta: fp.cuenta, monto: parseFloat(fp.monto) }));
            const adelIds = (adelantosPendientes || []).map(a => a.id);

            // Si la liq vino _generated (frontend la armó sin persistir),
            // la RPC la crea on-the-fly con p_crear_liq + p_calc.
            let pCalc: Partial<Liquidacion> | null = null;
            if (liq._generated) {
              const { _novedadId, _generated, id: _ignoreId, pagos_realizados: _ignorePag, ...calcFields } = liq;
              pCalc = calcFields;
            }

            const { data, error } = await db.rpc("pagar_sueldo", {
              p_nov_id: nov.id,
              p_formas_pago: formasValidas,
              p_adelantos_ids: adelIds,
              p_fecha: toISO(today),
              p_mes: pagoMes,
              p_anio: pagoAnio,
              p_crear_liq: !!liq._generated,
              p_calc: pCalc,
            });
            if (error) throw error;

            // RPC pagar_sueldo devuelve { completa: boolean, ... }. Tipo
            // estrecho para no usar `any` y validar la propiedad antes de
            // acceder.
            const ok = (data && typeof data === "object" && "completa" in data && data.completa === true);
            if (ok) {
              showToast("Pago completado");
            } else {
              showToast(`Pago parcial registrado — Resta ${fmt_$(restanteTrasEste)}`);
            }
            cerrarModal();
            await loadPagos();
            await loadEmpleados();
          } catch (err) {
            // RPC errors vienen como objects con shape PostgrestError. translateRpcError
            // los acepta; cast a Parameters[0] para satisfacer TS sin perder semántica.
            alert(translateRpcError(err as Parameters<typeof translateRpcError>[0]));
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
                    {adelantosPendientes.map(a => (
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
                      {cuentasUsables.map(c => <option key={c}>{c}</option>)}
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
                  {cuentasUsables.map(c => <option key={c}>{c}</option>)}
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

function TabHistorial({
  histMes, setHistMes, histAnio, setHistAnio, histLocal, setHistLocal,
  locsDisp, esEnc, histLoading, histData, histDetalle, setHistDetalle,
}: TabHistorialProps) {
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