import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { Modal } from "../components/ui";
import { db } from "../lib/supabase";
import { localesVisibles, applyLocalScope, cuentasOperables, tienePermiso } from "../lib/auth";
import { translateRpcError } from "../lib/errors";
import { usePuestosRRHH } from "../lib/usePuestosRRHH";
import { useGuardedHandler } from "../lib/useGuardedHandler";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";
import { toISO, toLocalISO } from '@pase/shared/utils';
import { today } from '../lib/utils';
import {
  calcularSACProporcional,
} from "../lib/calculos/rrhh";
// Lazy: RRHHLegajo (~1100 LOC) solo se monta cuando el usuario abre un legajo
// específico. Sin esto se cargaba eagerly aún cuando estás en el tab Dashboard.
const RRHHLegajo = lazy(() => import("./RRHHLegajo"));
import type { Usuario, Local } from "../types";
import type {
  Empleado, Novedad, Liquidacion,
  Adelanto, LineaPago,
} from "../types/rrhh";
// Tipos y helpers compartidos por los Tabs del módulo.
import type {
  EmpForm, EmpModalState, NovedadEditable, LiquidacionConGenerated,
  PagoDataRow, AdelantoForm, DashStats,
  LiquidacionConNovedadHist, PagoEspecialConEmpleado, AdelantoConEmpleado,
  HistRow,
} from "./rrhh/types";
import {
  calcLiquidacion, calcularValorDoble, MESES_NOMBRE, CUENTAS_PAGO,
  calcularCuotas, slotKey, cuotasParaModoPago,
} from "./rrhh/helpers";
// Sub-componentes (split F6 del 2026-05-11).
import { TabDashboard } from "./rrhh/TabDashboard";
import { TabEmpleados } from "./rrhh/TabEmpleados";
import { TabNovedades } from "./rrhh/TabNovedades";
import { TabPagos } from "./rrhh/TabPagos";
import { TabHistorial } from "./rrhh/TabHistorial";
import { AdelantoModal } from "./rrhh/AdelantoModal";

interface RRHHProps {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

// Los tipos del módulo y los helpers viven en ./rrhh/types.ts y
// ./rrhh/helpers.ts (split F6, 2026-05-11). Se importan al tope.

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function RRHH({ user, locales, localActivo }: RRHHProps) {
  // Cuentas para los selects de "Cuenta de pago" (adelanto y formas de pago
  // de sueldo). Filtra por cuentas_operables — un usuario con permiso de
  // cargar adelantos puede no ver el saldo de la cuenta destino.
  const opCuentas = cuentasOperables(user);
  const cuentasUsables = opCuentas === null ? CUENTAS_PAGO : CUENTAS_PAGO.filter(c => opCuentas.includes(c));
  const [tab, setTab] = useState("dashboard");
  const [legajoId, setLegajoId] = useState<string | null>(null);
  const { toast, showToast, showError } = useToast();

  const visLocs = localesVisibles(user);
  const locsDisp = visLocs === null ? locales : locales.filter((l: Local) => visLocs.includes(l.id));
  const esEnc = user?.rol === "encargado";
  // esDueno controla acciones de escritura en el módulo (pagar sueldos,
  // adelantos, confirmar novedades). Los encargados con permiso rrhh
  // explícito también pueden operar — fue el bug reportado en #dcd4f071:
  // el botón "Pagar" era invisible para encargados aunque tuvieran rrhh.
  const esDueno = user?.rol === "dueno" || user?.rol === "admin" || tienePermiso(user, "rrhh");
  // Default explícito a "" en vez de undefined cuando no hay match — los
  // selects luego usan String(...) y los handlers aceptan string vacío.
  const defaultLocal: string | number = localActivo
    || (locsDisp.length === 1 ? (locsDisp[0]?.id ?? "") : (esEnc && locsDisp.length ? (locsDisp[0]?.id ?? "") : ""));

  // ─── SHARED STATE ──────────────────────────────────────────────────────────
  const [allEmps, setAllEmps] = useState<Empleado[]>([]);
  const [empSearch, setEmpSearch] = useState("");
  const [vacTomadas, setVacTomadas] = useState<Record<string, number>>({});
  // empFiltLocal eliminado 2026-05-18: era fuente de contradicción con el
  // localActivo del sidebar (header del sidebar decía X, header del Equipo
  // decía Y). Ahora todo el scope viene del sidebar via applyLocalScope.
  // BUG 2: por defecto solo mostramos empleados activos. Toggle para incluir inactivos.
  const [empMostrarInactivos, setEmpMostrarInactivos] = useState(false);
  const [empModal, setEmpModal] = useState<EmpModalState>(null);
  const empEmpty: EmpForm = { local_id:"", apellido:"", nombre:"", cuil:"", puesto:"", sueldo_mensual:"", alias_mp:"", fecha_inicio:"", activo:true, dias_vacaciones_ya_tomados_al_alta:"0", registrado:false, modo_pago:"MENSUAL" };
  const [empForm, setEmpForm] = useState<EmpForm>(empEmpty);

  // Novedades
  const [novMes, setNovMes] = useState(today.getMonth() + 1);
  const [novAnio, setNovAnio] = useState(today.getFullYear());
  const [novLocal, setNovLocal] = useState(defaultLocal);
  const [novLocalTouched, setNovLocalTouched] = useState(false);
  const [novEmps, setNovEmps] = useState<Empleado[]>([]);
  // Slots de novedades: para cada empleado generamos N filas según modo_pago.
  // MENSUAL=1 slot, QUINCENAL=2 slots (Primera/Segunda Quincena), SEMANAL=4 slots.
  // Cada slot es una novedad independiente con cuota_num + cuotas_total.
  // Key del map: `${emp.id}__${cuota_num}` (acordado Lucas 21-may noche).
  const [novSlots, setNovSlots] = useState<Array<{ emp: Empleado; cuota_num: number; cuotas_total: number }>>([]);
  const [novMap, setNovMap] = useState<Record<string, NovedadEditable>>({});
  // Adelantos pendientes (descontado=false) del mes seleccionado, agrupados
  // por empleado_id. Reemplaza el viejo input editable "Adel.$" en la novedad
  // (que era un número libre sin link a la tabla real rrhh_adelantos —
  // bug "adelanto fantasma" detectado 2026-05-14). Ahora el cálculo de la
  // liquidación se hace contra el monto real persistido en rrhh_adelantos.
  const [novAdelantosPorEmp, setNovAdelantosPorEmp] = useState<Record<string, number>>({});
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
  // Idempotency key (convención C1) anti doble-click al confirmar pago de
  // sueldo. Se regenera al abrir el modal (línea ~711).
  const [idempKeyPagarSueldo, setIdempKeyPagarSueldo] = useState<string>(() => crypto.randomUUID());
  const [formasPago, setFormasPago] = useState<LineaPago[]>([]);
  // Fecha del pago — editable en el modal de pago de sueldo. Default today
  // pero Anto puede atrasarla cuando paga un sueldo de un mes anterior y
  // quiere que el movimiento quede registrado con la fecha real.
  const [fechaPago, setFechaPago] = useState<string>(toISO(today));
  const [adelantosPendientes, setAdelantosPendientes] = useState<Adelanto[]>([]);
  const [adelModal, setAdelModal] = useState(false);
  // Bug Caja-1: default vacío en cuenta fuerza elección consciente del user.
  const [adelForm, setAdelForm] = useState<AdelantoForm>({ empleado_id:"", monto:"", cuenta:"", fecha:toISO(today), descripcion:"" });

  // Defensive: resetea adelForm.cuenta a "" si queda fuera de cuentasUsables.
  // NO borrar — previene regresión del bug Caja-1.
  useEffect(() => {
    if (adelForm.cuenta && !cuentasUsables.includes(adelForm.cuenta)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAdelForm(a => ({ ...a, cuenta: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adelForm.cuenta, cuentasUsables.join("|")]);

  // Dashboard
  const [dashLoading, setDashLoading] = useState(true);
  const [dashStats, setDashStats] = useState<DashStats | Record<string, never>>({});

  // Historial — declarado ANTES del useEffect de SYNC para que el TDZ-check
  // del linter no flagee `histLocal` (lint react-hooks/immutability).
  const [histLocal, setHistLocal] = useState(defaultLocal);
  const [histMes, setHistMes] = useState(today.getMonth() + 1);
  const [histAnio, setHistAnio] = useState(today.getFullYear());
  const [histData, setHistData] = useState<HistRow[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histDetalle, setHistDetalle] = useState<HistRow | null>(null);

  // ─── SYNC LOCAL ACTIVO ────────────────────────────────────────────────────
  // Bug reportado 29-may (Lucas): cambiaba el local activo en el sidebar pero
  // /equipo seguía mostrando empleados del local viejo. La causa:
  // `novLocal` y `pagoLocal` se inicializan UNA vez al mount con `defaultLocal`
  // (que mira el `localActivo` del prop). Cuando el user cambia el local en
  // el sidebar, esos state quedan stale.
  //
  // Fix: cuando localActivo cambia y el user NO eligió manualmente otro local
  // (novLocalTouched / pagoLocalTouched = false), sincronizar los tabs con
  // el nuevo local activo.
  useEffect(() => {
    if (localActivo == null) return;
    if (!novLocalTouched && String(novLocal) !== String(localActivo)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNovLocal(localActivo);
    }
    if (!pagoLocalTouched && String(pagoLocal) !== String(localActivo)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPagoLocal(localActivo);
    }
    // Historial: sin "touched" flag, sincronizamos siempre. Es tab de lectura
    // (no se opera nada desde acá), el filtro propio si el user lo cambia se
    // mantiene hasta el siguiente cambio de localActivo en sidebar.
    if (String(histLocal) !== String(localActivo)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHistLocal(localActivo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo queremos correr al cambiar localActivo
  }, [localActivo]);

  // ─── LOAD FUNCTIONS ────────────────────────────────────────────────────────

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
    // Cargar adelantos pendientes (descontado=false) del mes seleccionado.
    const inicioMes = `${novAnio}-${String(novMes).padStart(2, "0")}-01`;
    const finMes = toLocalISO(new Date(novAnio, novMes, 0));
    const adelMap: Record<string, number> = {};
    empleados.forEach(e => { adelMap[e.id] = 0; });
    if (empIds.length) {
      const { data: adels } = await db.from("rrhh_adelantos")
        .select("empleado_id, monto")
        .in("empleado_id", empIds)
        .eq("descontado", false)
        .gte("fecha", inicioMes)
        .lte("fecha", finMes);
      (adels || []).forEach((a: { empleado_id?: string; monto?: number }) => {
        if (a.empleado_id) {
          adelMap[a.empleado_id] = (adelMap[a.empleado_id] || 0) + Number(a.monto || 0);
        }
      });
    }

    // Generar slots según modo_pago de cada empleado.
    // BUG FIX 22-may noche (Anto): antes priorizábamos el `cuotas_total`
    // guardado en DB, pero las novedades pre-22-may tienen cuotas_total=1
    // (default histórico). Para empleados QUINCENAL/SEMANAL eso mostraba
    // 1 sola fila en lugar de 2 o 4. Ahora SIEMPRE usamos el modo_pago
    // del empleado como fuente de verdad. Las novedades viejas se asignan
    // a la cuota 1; los slots faltantes (2,3,4) aparecen en estado borrador.
    const slots: Array<{ emp: Empleado; cuota_num: number; cuotas_total: number }> = [];
    const map: Record<string, NovedadEditable> = {};
    for (const emp of empleados) {
      const novsEmp = novs.filter(n => n.empleado_id === emp.id);
      const cuotasPorModo = cuotasParaModoPago(emp.modo_pago);

      // Tomamos el máximo entre modo_pago y lo que ya hay en DB. Esto
      // protege el caso edge donde alguien cambia un empleado de QUINCENAL
      // a MENSUAL: la novedad vieja con cuotas_total=2 sigue visible.
      const cuotasMaxDB = novsEmp.length > 0
        ? Math.max(...novsEmp.map(n => n.cuotas_total ?? 1))
        : 0;
      const cuotasTotalDB = Math.max(cuotasPorModo, cuotasMaxDB);

      for (let c = 1; c <= cuotasTotalDB; c++) {
        const existing = novsEmp.find(n => (n.cuota_num ?? 1) === c);
        const key = slotKey(emp.id, c);
        slots.push({ emp, cuota_num: c, cuotas_total: cuotasTotalDB });
        map[key] = existing || {
          inasistencias: 0, presentismo: "MANTIENE", horas_extras: 0, dobles: 0,
          feriados: 0, adelantos: 0, vacaciones_dias: 0, fecha_inicio_mes: null,
          observaciones: "", estado: "borrador",
          cuota_num: c, cuotas_total: cuotasTotalDB,
        };
      }
    }
    setNovEmps(empleados);
    setNovSlots(slots);
    setNovMap(map);
    setNovAdelantosPorEmp(adelMap);
    setNovLoading(false);
  };

  // Cambia al tab Pagos pre-cargando los filtros con los mismos valores que
  // el usuario tenía en Novedades. UX: confirmás la novedad → un click te
  // lleva a pagar con el contexto ya seteado.
  const irAPagosDesdeNovedades = () => {
    setPagoMes(novMes);
    setPagoAnio(novAnio);
    setPagoLocal(novLocal);
    setPagoLocalTouched(true);
    setTab("pagos");
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

    // Nuevo modelo (22-may noche): cada cuota es una novedad independiente con
    // su propio cuota_num + cuotas_total. Para empleados QUINCENAL hay 2
    // novedades por mes (cuota 1 + cuota 2), para SEMANAL hay 4.
    //
    // BUG FIX 22-may noche (Carolina Vazquez 2da quincena no aparecía): antes
    // hacíamos `novedades.find(...)` y solo procesábamos la primera. Ahora
    // iteramos sobre TODAS las novedades del empleado en el mes y mostramos
    // una fila por cada cuota independiente.
    const merged: PagoDataRow[] = empleados.flatMap((emp) => {
      const novsEmp = novedades
        .filter(n => n.empleado_id === emp.id)
        .sort((a, b) => (a.cuota_num ?? 1) - (b.cuota_num ?? 1));
      if (novsEmp.length === 0) return [];

      return novsEmp.flatMap((nov) => {
        const persistedRows = liqs
          .filter(l => l.novedad_id === nov.id)
          .sort((a, b) => (a.cuota_num ?? 1) - (b.cuota_num ?? 1));
        if (persistedRows.length > 0) {
          return persistedRows.map(liq => ({ emp, nov, liq: liq as LiquidacionConGenerated }));
        }
        // Sin liq persistida: calculamos on-the-fly. Respeta el cuota_num
        // de la novedad (que vino de la migration 213200).
        const vd = calcularValorDoble(emp);
        const calc = calcLiquidacion(emp, nov, vd);
        const liq: LiquidacionConGenerated = {
          ...calc,
          total_a_pagar: Math.round(calc.total_a_pagar),
          estado: "pendiente",
          cuota_num: nov.cuota_num ?? 1,
          cuotas_total: nov.cuotas_total ?? 1,
          _novedadId: nov.id,
          _generated: true,
        };
        return [{ emp, nov, liq }];
      });
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
    // Multi-cuota: una novedad puede tener N liqs. "Pagado" solo si TODAS
    // las cuotas están pagadas. "Total" es la suma de cuotas.
    const liqsPorNov = (novId: string) => liqsDash.filter(l => l.novedad_id === novId);
    const pagados = novsMes.filter(n => {
      const ls = liqsPorNov(n.id ?? "");
      return ls.length > 0 && ls.every(l => l.estado === "pagado");
    }).length;
    // Estimado a pagar (suma total mensual por empleado, agregando cuotas).
    let estimado = 0;
    activos.forEach(emp => {
      const nov = novsMes.find(n => n.empleado_id === emp.id);
      if (nov && nov.estado === "confirmado") {
        const ls = liqsPorNov(nov.id ?? "");
        if (ls.length > 0) {
          estimado += ls.reduce((s, l) => s + Number(l.total_a_pagar || 0), 0);
        } else {
          estimado += Number(emp.sueldo_mensual);
        }
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
  // Recarga empleados cuando cambia el sidebar (localActivo). Bug 2026-05-18:
  // antes era `[]` (solo on mount), así que cambiar el local desde el sidebar
  // dejaba la lista stale — Lucas pasaba de Villa Crespo a Belgrano y seguía
  // viendo los empleados de Villa Crespo (o ninguno si era un local sin data
  // cuando montó la pantalla).
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { loadEmpleados(); }, [localActivo]);
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
  // Lista de puestos para el dropdown del form. Catálogo persistente desde
  // 2026-05-12 (tabla rrhh_puestos, migration 202605122200) — antes salía
  // de los empleados existentes, lo cual hacía que Camilo viera puestos
  // distintos en cada local según qué se había tipeado. Ahora todos ven la
  // misma lista, gestionable desde Configuración → Puestos RRHH.
  //
  // Si un empleado existente tiene un puesto legacy fuera del catálogo
  // (string libre), lo agregamos a la lista para que aparezca en el dropdown
  // al editarlo (no perdemos información).
  const { puestosActivos } = usePuestosRRHH();
  const puestosCatalogo = puestosActivos.map(p => p.nombre);
  const puestosLegacy = [...new Set(allEmps.map(e => e.puesto).filter(Boolean))]
    .filter(p => !puestosCatalogo.includes(p));
  const puestos = [...puestosCatalogo, ...puestosLegacy].sort();
  // Bug 2026-05-18 (Lucas): el filtro "Sucursal" de la pantalla creaba una
  // contradicción cuando el sidebar marcaba un local pero la pantalla otro.
  // Decisión: la fuente única de verdad para el local es el sidebar
  // (localActivo). La pantalla ya NO tiene filtro propio; solo respeta el
  // scope del sidebar (vía applyLocalScope en loadEmpleados).
  const empsFilt = allEmps.filter(e => {
    if (!empMostrarInactivos && e.activo === false) return false;
    if (empSearch && !(`${e.apellido} ${e.nombre}`).toLowerCase().includes(empSearch.toLowerCase())) return false;
    return true;
  });

  // Guarded por useGuardedHandler — bloquea doble-click rápido. Bug
  // 2026-05-18: Anto pegó dos veces "Guardar" y se duplicó el empleado.
  const guardarEmpHandler = useGuardedHandler(async () => {
    if (!empForm.apellido || !empForm.nombre || !empForm.local_id || !empForm.puesto || !empForm.sueldo_mensual || !empForm.fecha_inicio) return;
    const payload = {
      ...empForm,
      local_id: parseInt(empForm.local_id),
      sueldo_mensual: parseFloat(empForm.sueldo_mensual) || 0,
      dias_vacaciones_ya_tomados_al_alta: parseInt(empForm.dias_vacaciones_ya_tomados_al_alta || "0") || 0,
      registrado: empForm.registrado,
    };
    const existing = empModal && empModal !== "new" ? empModal : null;

    // Fix bug Anto 21-may: prevenir duplicados de CUIL al crear (no al editar).
    // Hay casos en DB con mismo CUIL en distintos registros (JANKOWSKY x2,
    // Argañaraz x2). El useGuardedHandler bloquea doble-click pero no impide
    // que un usuario crea de nuevo a un empleado que ya existe.
    if (!existing && empForm.cuil && empForm.cuil.replace(/[^0-9]/g, '').length >= 8) {
      const { data: dup } = await db.from("rrhh_empleados")
        .select("id, apellido, nombre, local_id")
        .eq("cuil", empForm.cuil)
        .limit(1);
      if (dup && dup.length > 0) {
        const d = dup[0]!;
        const confirmar = window.confirm(
          `Ya existe un empleado con CUIL ${empForm.cuil}:\n\n` +
          `  ${d.apellido}, ${d.nombre} (local ${d.local_id})\n\n` +
          `¿Querés crear OTRO registro igual? (cancelá si es un error de carga)`
        );
        if (!confirmar) return;
      }
    }

    if (existing) {
      const sueldoAnt = Number(existing.sueldo_mensual);
      if (sueldoAnt !== payload.sueldo_mensual && sueldoAnt > 0) {
        await db.from("rrhh_historial_sueldos").insert([{
          empleado_id: existing.id, sueldo_anterior: sueldoAnt, sueldo_nuevo: payload.sueldo_mensual,
          motivo: "Edición desde listado", registrado_por: user?.id,
        }]);
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { valor_dia, valor_hora, creado_at, vacaciones_dias_acumulados, aguinaldo_acumulado, fecha_egreso, motivo_baja, ...upd } = payload as Partial<Empleado> & Record<string, unknown>;
      await db.from("rrhh_empleados").update(upd).eq("id", existing.id);
    } else {
      await db.from("rrhh_empleados").insert([payload]);
    }
    setEmpModal(null); loadEmpleados();
  });
  const guardarEmp = guardarEmpHandler.run;
  const guardandoEmp = guardarEmpHandler.isPending;

  const abrirEmpNuevo = () => {
    // Pre-popular SOLO si el sidebar tiene una sucursal específica O si el
    // user tiene 1 solo local visible. En modo "Todas las sucursales", dejamos
    // vacío para forzar elección explícita (decisión Lucas 2026-05-17).
    let pre = "";
    if (localActivo != null) pre = String(localActivo);
    else if (locsDisp.length === 1) pre = String(locsDisp[0]!.id);
    setEmpForm({ ...empEmpty, local_id: pre });
    setEmpModal("new");
  };
  const abrirEmpEditar = (e: Empleado) => {
    setEmpForm({
      local_id: e.local_id ? String(e.local_id) : "",
      apellido:e.apellido, nombre:e.nombre, cuil:e.cuil||"",
      puesto:e.puesto, sueldo_mensual:String(e.sueldo_mensual),
      alias_mp:e.alias_mp||"", fecha_inicio:e.fecha_inicio||"", activo:e.activo,
      dias_vacaciones_ya_tomados_al_alta: String((e as { dias_vacaciones_ya_tomados_al_alta?: number }).dias_vacaciones_ya_tomados_al_alta ?? 0),
      registrado: Boolean((e as { registrado?: boolean }).registrado),
      modo_pago: e.modo_pago || "MENSUAL",
    });
    setEmpModal(e);
  };

  // ─── NOVEDADES ACTIONS ─────────────────────────────────────────────────────
  // Las funciones de abajo reciben `key` = slotKey(empId, cuota_num).
  // Para empleados MENSUAL, cuota_num=1 (key = `${empId}__1`).
  // Para QUINCENAL hay 2 slots (cuota_num=1 y 2). SEMANAL: 4.
  const updateNov = (key: string, field: keyof NovedadEditable, value: string | number) => {
    setNovMap(prev => {
      const nextNov: NovedadEditable = { ...prev[key], [field]: value };
      const updated = { ...prev, [key]: nextNov };
      if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
      saveTimers.current[key] = setTimeout(() => saveNovedad(key, nextNov), 800);
      return updated;
    });
  };

  const saveNovedad = async (key: string, nov: NovedadEditable) => {
    const empId = key.split("__")[0]!;
    const cuotaNum = nov.cuota_num ?? Number(key.split("__")[1] ?? 1);
    const cuotasTotal = nov.cuotas_total ?? 1;
    const { id, estado, vacaciones_dias: _vac, ...rest } = nov;
    await db.from("rrhh_novedades").upsert({
      ...(id ? { id } : {}),
      empleado_id: empId,
      mes: novMes, anio: novAnio,
      cuota_num: cuotaNum, cuotas_total: cuotasTotal,
      ...rest,
      estado: estado || "borrador",
      cargado_por: user?.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: "empleado_id,mes,anio,cuota_num" });
  };

  const confirmarUno = async (emp: Empleado, cuotaNum: number, cuotasTotal: number) => {
    const key = slotKey(emp.id, cuotaNum);
    const nov = novMap[key];
    if (!nov) return;
    const adelantosDelMes = novAdelantosPorEmp[emp.id] ?? 0;
    const otrosDesc = nov.otros_descuentos || 0;
    const otrosDescMotivo = (nov.otros_descuentos_motivo || "").trim();
    if (otrosDesc > 0 && !otrosDescMotivo) {
      showError(`${emp.apellido} ${emp.nombre}: cargá el motivo del descuento de $${otrosDesc.toLocaleString('es-AR')}.`);
      return;
    }
    const { data: saved } = await db.from("rrhh_novedades").upsert({
      ...(nov.id ? { id: nov.id } : {}),
      empleado_id: emp.id,
      mes: novMes, anio: novAnio,
      cuota_num: cuotaNum, cuotas_total: cuotasTotal,
      inasistencias: nov.inasistencias || 0,
      presentismo: nov.presentismo || "MANTIENE",
      horas_extras: nov.horas_extras || 0,
      dobles: nov.dobles || 0,
      feriados: nov.feriados || 0,
      vacaciones_dias: nov.vacaciones_dias || 0,
      adelantos: adelantosDelMes,
      otros_descuentos: otrosDesc,
      otros_descuentos_motivo: otrosDesc > 0 ? otrosDescMotivo : null,
      fecha_inicio_mes: nov.fecha_inicio_mes || null,
      observaciones: nov.observaciones || "",
      estado: "confirmado",
      cargado_por: user?.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: "empleado_id,mes,anio,cuota_num" }).select().single();

    if (saved) {
      const vd = calcularValorDoble(emp);
      const calc = calcLiquidacion(emp, nov, vd, adelantosDelMes);
      // Modelo nuevo (21-may noche): cada novedad cuota_num genera UNA sola
      // liquidación (no N cuotas). El cuotas_total se preserva para que la
      // UI sepa que es una quincena/semana. El vencimiento de la cuota se
      // calcula según cuota_num + cuotas_total.
      const { vencimientos } = calcularCuotas(
        cuotasTotal === 2 ? "QUINCENAL" : cuotasTotal === 4 ? "SEMANAL" : "MENSUAL",
        novMes, novAnio,
      );
      const vencimiento = vencimientos[cuotaNum - 1] || vencimientos[vencimientos.length - 1];
      // Borrar liquidación previa de esta novedad (re-confirmar) y crear la nueva
      // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F14: el delete+insert de la liquidación al confirmar novedad debería ir por RPC confirmar_novedad atómica.
      await db.from("rrhh_liquidaciones").delete().eq("novedad_id", saved.id);
      // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F14: idem.
      await db.from("rrhh_liquidaciones").insert([{
        novedad_id: saved.id,
        sueldo_base: calc.sueldo_base,
        descuento_ausencias: calc.descuento_ausencias,
        total_horas_extras: calc.total_horas_extras,
        total_dobles: calc.total_dobles,
        total_feriados: calc.total_feriados,
        total_vacaciones: calc.total_vacaciones,
        subtotal1: calc.subtotal1,
        monto_presentismo: calc.monto_presentismo,
        subtotal2: calc.subtotal2,
        adelantos: calc.adelantos,
        pagos_realizados: 0,
        total_a_pagar: calc.total_a_pagar,
        efectivo: calc.efectivo,
        transferencia: calc.transferencia,
        estado: "pendiente",
        calculado_at: new Date().toISOString(),
        cuota_num: cuotaNum,
        cuotas_total: cuotasTotal,
        fecha_vencimiento: vencimiento,
      }]);
    }
    const label = cuotasTotal > 1 ? ` (${cuotaNum}/${cuotasTotal})` : "";
    showToast(`${emp.apellido}${label} confirmado`);
    loadNovedades();
  };

  const editarNov = async (key: string) => {
    const nov = novMap[key];
    if (!nov?.id) return;
    // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F14: rollback novedad→borrador debe pasar por RPC editar_novedad que borre liq + cambie estado atómicamente.
    await db.from("rrhh_liquidaciones").delete().eq("novedad_id", nov.id);
    await db.from("rrhh_novedades").update({ estado: "borrador" }).eq("id", nov.id);
    setNovMap(prev => ({ ...prev, [key]: { ...prev[key], estado: "borrador" } }));
  };

  // Eliminar novedad completa. Usos:
  //   1. Convertir mensual existente a quincenal (Lucas 21-may noche):
  //      borrar la mensual, recargar Novedades, aparecen 2 slots vacíos Q1+Q2.
  //   2. Limpiar novedad cargada por error.
  // Bloqueos:
  //   - Si la liquidación está pagada (pagos_realizados > 0): NO permite borrar.
  //     Hay que anular el pago primero desde Pagos. (Trazabilidad financiera.)
  const eliminarNov = async (key: string) => {
    const nov = novMap[key];
    if (!nov?.id) {
      // No existe en DB todavía — solo limpiamos el slot del mapa.
      setNovMap(prev => ({ ...prev, [key]: {
        inasistencias: 0, presentismo: "MANTIENE", horas_extras: 0, dobles: 0,
        feriados: 0, adelantos: 0, vacaciones_dias: 0, fecha_inicio_mes: null,
        observaciones: "", estado: "borrador",
        cuota_num: prev[key]?.cuota_num, cuotas_total: prev[key]?.cuotas_total,
      } }));
      return;
    }
    // Chequear si hay liquidaciones pagadas.
    const { data: liqs } = await db.from("rrhh_liquidaciones")
      .select("id, pagos_realizados, estado")
      .eq("novedad_id", nov.id);
    const hayPagada = (liqs || []).some(l => Number(l.pagos_realizados || 0) > 0 || l.estado === "pagado");
    if (hayPagada) {
      showError("Esta novedad tiene una liquidación con pagos registrados. Primero anulá el pago desde Pagos.");
      return;
    }
    const cuotasTotal = nov.cuotas_total ?? 1;
    const motivo = cuotasTotal === 1
      ? "Eliminar la novedad de este mes? Si el empleado tiene modo_pago QUINCENAL/SEMANAL, al recargar Novedades vas a ver los slots vacíos por quincena/semana."
      : "Eliminar esta novedad? Se borra del mes y queda en blanco para volver a cargar.";
    if (!confirm(motivo)) return;

    // Borrar liquidaciones pendientes + novedad.
    // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F14: borrado de novedad debe ir por RPC eliminar_novedad atómica.
    await db.from("rrhh_liquidaciones").delete().eq("novedad_id", nov.id);
    await db.from("rrhh_novedades").delete().eq("id", nov.id);
    showToast("Novedad eliminada");
    loadNovedades();
  };

  // BUG 4: bulk-confirmar todos los empleados en borrador. Cierra de un tirón
  // las novedades del mes y crea las liquidaciones (estado "pendiente"), que
  // es el equivalente a "listo para pago".
  const confirmarTodas = async () => {
    // En el modelo nuevo (quincenas: 21-may noche) iteramos slots, no empleados.
    // Cada slot es una novedad independiente con su cuota_num + cuotas_total.
    const enBorrador = novSlots.filter(s => {
      const nov = novMap[slotKey(s.emp.id, s.cuota_num)];
      return (nov?.estado ?? "borrador") !== "confirmado";
    });
    if (enBorrador.length === 0) { showToast("Todas ya están confirmadas"); return; }
    if (!confirm(`Confirmar ${enBorrador.length} novedad${enBorrador.length > 1 ? "es" : ""} pendiente${enBorrador.length > 1 ? "s" : ""}? Pasan a estado "listo para pago".`)) return;
    Object.values(saveTimers.current).forEach(t => clearTimeout(t));
    for (const slot of enBorrador) {
      await confirmarUno(slot.emp, slot.cuota_num, slot.cuotas_total);
    }
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
    setIdempKeyPagarSueldo(crypto.randomUUID());
    // La primera línea de pago hereda el local principal del empleado.
    // Lucas 2026-05-20: el dueño puede cambiarlo para repartir el sueldo
    // entre varios locales (ej. admin que trabaja para varias sucursales).
    setFormasPago(pendienteCash > 0
      ? [{ cuenta: "", monto: String(pendienteCash), local_id: emp.local_id ?? null }]
      : []);
    // Default a HOY (cuando realmente sale la plata). Anto reportó
    // 2026-05-20 que antes el default era `fecha_vencimiento` (fin de mes)
    // y no se daba cuenta de que podía cambiarla — el resultado: pagos
    // con fecha futura que no aparecían en el listado de movimientos
    // (filtro por defecto hasta hoy). El mes liquidado ya está en el
    // filtro de Pagos, no hace falta repetirlo en la fecha del movimiento.
    setFechaPago(toISO(today));
  };

  const { run: guardarAdelanto, isPending: guardandoAdelanto } = useGuardedHandler(async () => {
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
    if (error) { showError(translateRpcError(error)); return; }

    showToast(`Adelanto registrado — ${emp.apellido}`);
    setAdelModal(false);
    setAdelForm({ empleado_id:"", monto:"", cuenta:"", fecha:toISO(today), descripcion:"" });
    if (tab === "pagos") await loadPagos();
  });

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
      <ToastComponent toast={toast} />

      <div className="ph-row">
        <div><div className="ph-title">Equipo</div></div>
      </div>

      <div className="tabs">
        {tabs.map(t => <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</div>)}
      </div>

      {tab === "dashboard" && <TabDashboard dashStats={dashStats} dashLoading={dashLoading} />}

      {tab === "empleados" && (
        <TabEmpleados
          empSearch={empSearch}
          setEmpSearch={setEmpSearch}
          empMostrarInactivos={empMostrarInactivos}
          setEmpMostrarInactivos={setEmpMostrarInactivos}
          esEnc={esEnc}
          locsDisp={locsDisp}
          locales={locales}
          localActivo={localActivo}
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
          guardandoEmp={guardandoEmp}
          setLegajoId={setLegajoId}
          puedeVerInactivos={tienePermiso(user, "ver_anulados")}
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
          novSlots={novSlots}
          novMap={novMap}
          novAdelantosPorEmp={novAdelantosPorEmp}
          updateNov={updateNov}
          confirmarUno={confirmarUno}
          confirmarTodas={confirmarTodas}
          editarNov={editarNov}
          eliminarNov={eliminarNov}
          irAPagos={irAPagosDesdeNovedades}
          abrirModalAdelanto={(empId: string) => {
            // Pre-cargar el empleado en el form + abrir modal (que vive
            // en TabPagos pero el state está acá → funciona en cualquier tab).
            setAdelForm(a => ({ ...a, empleado_id: empId }));
            setAdelModal(true);
          }}
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
          guardandoAdelanto={guardandoAdelanto}
          adelantosPendientes={adelantosPendientes}
          setAdelantosPendientes={setAdelantosPendientes}
          abrirPagoSueldo={abrirPagoSueldo}
          cuentasUsables={cuentasUsables}
          idempKeyPagarSueldo={idempKeyPagarSueldo}
          fechaPago={fechaPago}
          setFechaPago={setFechaPago}
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
      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido. */}
      <Modal
        isOpen={!!legajoId}
        onClose={() => { setLegajoId(null); loadEmpleados(); }}
        title="Legajo"
        maxWidth={1100}
      >
        {legajoId && (
          <Suspense fallback={<div style={{padding:24,color:"var(--muted)"}}>Cargando legajo…</div>}>
            <RRHHLegajo empleadoId={legajoId} user={user} locales={locales} onClose={() => { setLegajoId(null); loadEmpleados(); }} onGoToPago={goToPagoFromLegajo} />
          </Suspense>
        )}
      </Modal>

      {/* Modal de adelanto a nivel padre — accesible desde cualquier tab.
          Antes estaba dentro de TabPagos y no funcionaba desde Novedades. */}
      <AdelantoModal
        open={adelModal}
        onClose={() => setAdelModal(false)}
        allEmps={allEmps}
        empleadosExtra={novEmps}
        filtroLocalId={pagoLocal ? parseInt(String(pagoLocal)) : (novLocal ? parseInt(String(novLocal)) : null)}
        adelForm={adelForm}
        setAdelForm={setAdelForm}
        cuentasUsables={cuentasUsables}
        guardarAdelanto={guardarAdelanto}
        guardando={guardandoAdelanto}
      />
    </div>
  );
}
