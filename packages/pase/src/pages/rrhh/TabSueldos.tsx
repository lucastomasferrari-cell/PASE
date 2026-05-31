// ─────────────────────────────────────────────────────────────────────────
// TAB SUELDOS — Pantalla unificada (reemplaza Novedades + Pagos + Historial)
// ─────────────────────────────────────────────────────────────────────────
//
// Diseño aprobado por Lucas (31-may-2026) tras el mockup en /sueldos-preview.
//
//   - 1 card por empleado (no 1 por cuota). Quincenales muestran Q1+Q2 como
//     sub-filas dentro de la misma card.
//   - Al expandir: tabs Q1/Q2 si quincenal, novedades + adelantos + cálculo
//     en vivo.
//   - Novedades: AUTOSAVE silencioso con debounce 800ms a rrhh_novedades.
//     Indicador "✓ Guardado" al lado del título.
//   - Adelantos: + Adelanto desde la card → RPC registrar_adelanto real.
//     Checkboxes por adelanto en el modal de pago (saldo flexible).
//   - Pagar: RPC pagar_sueldo real con p_adelantos_ids selectivo +
//     idempotency_key. Sin paso "Confirmar" previo.
//   - Estado borrador/confirmado: se mantiene en DB invisible. Autosave
//     guarda con estado='borrador'. pagar_sueldo marca confirmado.
//   - Historial (pagos viejos): mismo lugar, filtro "Pagados" + cambiar mes.
//     No hay tab Historial separado.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { db } from "../../lib/supabase";
import { fmt_$, fmt_d, toISO, parseMonto } from "@pase/shared/utils";
import { today } from "../../lib/utils";
import { Modal } from "../../components/ui";
import { translateRpcError } from "../../lib/errors";
import { useToast } from "../../hooks/useToast";
import { ToastComponent } from "../../components/Toast";
import type { Local } from "../../types";
import type { Usuario } from "../../types/auth";

// ── Tipos locales ──────────────────────────────────────────────────────────
interface Emp {
  id: string;
  nombre: string;
  apellido: string;
  puesto: string;
  sueldo_mensual: number;
  modo_pago: "MENSUAL" | "QUINCENAL" | "SEMANAL";
  local_id: number | null;
  activo: boolean;
  alias_mp?: string | null;
}
interface Adel {
  id: string;
  empleado_id: string;
  fecha: string;
  monto: number;
  cuenta: string | null;
  descontado: boolean;
  auto_aplicar?: boolean;
  concepto?: string | null;
}
interface NovDB {
  id: string;
  empleado_id: string;
  mes: number;
  anio: number;
  cuota_num: number | null;
  cuotas_total: number | null;
  inasistencias: number;
  presentismo: "MANTIENE" | "NO_MANTIENE" | null;
  horas_extras: number;
  dobles: number;
  feriados: number;
  otros_descuentos: number | null;
  otros_descuentos_motivo: string | null;
  observaciones: string | null;
  estado: string;
}
interface LiqEstado {
  empleado_id: string;
  cuota_num: number;
  cuotas_total: number;
  estado: "pendiente" | "pagado";
  // Extendido 31-may: para vista de pagado necesitamos saber el id de liq,
  // total pagado y poder cargar movimientos asociados.
  liq_id: string | null;
  total_a_pagar: number;
  pagos_realizados: number;
}
// Movimiento de pago asociado a una liquidación (para mostrar medios+fechas en
// la vista de "pagado").
interface MovPago {
  id: string;
  liquidacion_id: string;
  cuenta: string;
  importe: number;
  fecha: string;
  anulado: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fechaFinPeriodo(anio: number, mes: number, cuotaNum: number, cuotasTotal: number): string {
  if (cuotasTotal === 1 || cuotaNum === 2) {
    const ult = new Date(anio, mes, 0).getDate();
    return `${anio}-${String(mes).padStart(2, "0")}-${String(ult).padStart(2, "0")}`;
  }
  return `${anio}-${String(mes).padStart(2, "0")}-15`;
}
function fechaInicioPeriodo(anio: number, mes: number, cuotaNum: number, cuotasTotal: number): string {
  if (cuotasTotal === 1 || cuotaNum === 1) return `${anio}-${String(mes).padStart(2, "0")}-01`;
  return `${anio}-${String(mes).padStart(2, "0")}-16`;
}
function labelSlot(cuotaNum: number, cuotasTotal: number): string {
  if (cuotasTotal === 1) return "Mes";
  return cuotaNum === 1 ? "Q1" : "Q2";
}
function nombreMes(m: number): string {
  return ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"][m - 1] || "";
}

// State editable por slot (cuotaKey = `${empId}__${cuota}`)
interface NovEdit {
  inasistencias: number;
  horas_extras: number;
  dobles: number;
  feriados: number;
  presentismo_mantiene: boolean;
  otros_desc: number;
  obs: string;
}
const NOV_VACIA: NovEdit = {
  inasistencias: 0, horas_extras: 0, dobles: 0, feriados: 0,
  presentismo_mantiene: true, otros_desc: 0, obs: "",
};
function novDBaEdit(n: NovDB | undefined): NovEdit {
  if (!n) return { ...NOV_VACIA };
  return {
    inasistencias: Number(n.inasistencias || 0),
    horas_extras: Number(n.horas_extras || 0),
    dobles: Number(n.dobles || 0),
    feriados: Number(n.feriados || 0),
    presentismo_mantiene: n.presentismo !== "NO_MANTIENE",
    otros_desc: Number(n.otros_descuentos || 0),
    obs: n.observaciones || "",
  };
}

// Desglose del cálculo de un slot. Devuelve todos los componentes para
// poder mostrarlos en vivo en el panel derecho, no solo el total final.
interface DesgloseCalculo {
  baseCuota: number;
  descInas: number;        // descuento por inasistencias
  ingrExtras: number;      // ingreso por horas extras
  ingrDobles: number;      // ingreso por turnos dobles
  ingrFeriados: number;    // ingreso por feriados trabajados
  presentismo: number;     // 5% del sueldo BASE (cambio Lucas 31-may)
  otrosDesc: number;
  totalAdelantos: number;
  total: number;
}
function calcularDesglose(emp: Emp, nov: NovEdit, cuotasTotal: number, cuotaNum: number, adelantosATildar: number): DesgloseCalculo {
  const baseCuota = emp.sueldo_mensual / cuotasTotal;
  const diasMes = 30;
  // Cambio Lucas 31-may noche: faltas/feriados/dobles/extras se calculan
  // SIEMPRE sobre el sueldo MENSUAL completo, NUNCA dividido por la quincena.
  // Antes: valorDia = sueldo / 30 / cuotasTotal → para quincenales daba la
  // MITAD del valor real, y una falta en Q1 descontaba la mitad de lo que
  // realmente vale el día. Por eso Bernal Q1 mayo daba $347K en vez de
  // los $226K realmente pagados (las 7 faltas se calculaban a $14K en vez
  // de $28K cada una).
  const valorDia = emp.sueldo_mensual / diasMes;
  const valorHora = valorDia / 8;
  const descInas = nov.inasistencias * valorDia;
  const ingrExtras = nov.horas_extras * valorHora * 1.5;
  // Cambio Lucas 31-may noche v2: tanto feriados como dobles se pagan como
  // 1 DÍA EXTRA (sueldo/30), no como día doble ni 1.5×. El día trabajado
  // ya está cubierto por el sueldo base — solo se suma el extra.
  // Antes (mal): feriados × 2 (= 2 días extras), dobles × 1.5.
  // Coincide con helpers.ts:calcularValorDoble y con calcularTotalLiquidacion
  // que ya tenían "feriados × valor_dia" sin multiplicar.
  const ingrDobles = nov.dobles * valorDia;
  const ingrFeriados = nov.feriados * valorDia;
  // Presentismo:
  //  - Mensuales (cuotasTotal=1): 5% del sueldo mensual (igual que antes).
  //  - Quincenales: NO se paga en Q1 — se paga UNA sola vez a fin de mes
  //    cuando ya se sabe si se perdió o no. En Q2: 5% del sueldo MENSUAL
  //    completo (no de la quincena), porque el presentismo se calcula
  //    sobre el sueldo base completo.
  // Pedido Lucas 31-may noche. Antes el código aplicaba 5% del baseCuota
  // en TODA quincena, lo que daba la mitad del presentismo real y aplicaba
  // doble (en Q1 y Q2).
  let presentismo = 0;
  if (nov.presentismo_mantiene) {
    if (cuotasTotal === 1) presentismo = emp.sueldo_mensual * 0.05;
    else if (cuotaNum === 2) presentismo = emp.sueldo_mensual * 0.05;
    // cuotaNum === 1 && cuotasTotal === 2 → presentismo = 0
  }
  const subtotal = baseCuota - descInas + ingrExtras + ingrDobles + ingrFeriados + presentismo;
  const total = Math.max(0, Math.round(subtotal - nov.otros_desc - adelantosATildar));
  return {
    baseCuota: Math.round(baseCuota),
    descInas: Math.round(descInas),
    ingrExtras: Math.round(ingrExtras),
    ingrDobles: Math.round(ingrDobles),
    ingrFeriados: Math.round(ingrFeriados),
    presentismo: Math.round(presentismo),
    otrosDesc: Math.round(nov.otros_desc),
    totalAdelantos: Math.round(adelantosATildar),
    total,
  };
}
// Wrapper backward-compat (los callers viejos solo quieren el total).
function calcularTotal(emp: Emp, nov: NovEdit, cuotasTotal: number, cuotaNum: number, adelantosATildar: number): number {
  return calcularDesglose(emp, nov, cuotasTotal, cuotaNum, adelantosATildar).total;
}

// ── Props ──────────────────────────────────────────────────────────────────
interface TabSueldosProps {
  user: Usuario;
  esDueno: boolean;
  esEnc: boolean;
  locsDisp: Local[];
  localActivo: number | null;
  cuentasUsables: string[];
}

// ── Componente principal ───────────────────────────────────────────────────
export function TabSueldos({
  // user: prop reservada para futuro (auth check, default fields, etc.).
  // Por ahora no la usamos directo — RLS protege.
  user: _user, esDueno, esEnc, locsDisp, localActivo, cuentasUsables,
}: TabSueldosProps) {
  // Filtros
  const now = new Date();
  const [mes, setMes] = useState(now.getMonth() + 1);
  const [anio, setAnio] = useState(now.getFullYear());
  // Encargado solo ve su local activo; dueño puede cambiar local desde el
  // dropdown propio (default: el del sidebar)
  const [localId, setLocalId] = useState<number | null>(localActivo);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sync prop → state intencional
  useEffect(() => { if (localActivo != null) setLocalId(localActivo); }, [localActivo]);
  const [filtroEstado, setFiltroEstado] = useState<"todos" | "pendientes" | "pagados">("pendientes");

  // Data real desde DB
  const [empleados, setEmpleados] = useState<Emp[]>([]);
  const [adelantos, setAdelantos] = useState<Adel[]>([]);
  const [novedadesDB, setNovedadesDB] = useState<NovDB[]>([]);
  const [liqs, setLiqs] = useState<LiqEstado[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast, showToast, showError } = useToast();

  // Recargar todo (después de cualquier mutación)
  const recargar = useCallback(async () => {
    if (!localId) return;
    setLoading(true);
    const { data: emps } = await db.from("rrhh_empleados")
      .select("id, nombre, apellido, puesto, sueldo_mensual, modo_pago, local_id, activo, alias_mp")
      .eq("activo", true)
      .eq("local_id", localId)
      .order("apellido");
    setEmpleados((emps || []) as Emp[]);

    const empIds = ((emps || []) as Emp[]).map(e => e.id);
    if (empIds.length > 0) {
      // Cambio Lucas 31-may: traer TODOS los adelantos pendientes del
      // empleado, sin filtro de fecha. Antes filtraba por mes activo →
      // un adelanto de hace 3 meses no aparecía. Ahora aparecen todos los
      // descontado=false ordenados por fecha (más viejo primero, así Anto
      // ve "Carlos tiene un saldo pendiente del 5/feb" aunque esté pagando
      // su sueldo de mayo).
      const { data: ads } = await db.from("rrhh_adelantos")
        .select("id, empleado_id, fecha, monto, cuenta, descontado, auto_aplicar, concepto")
        .in("empleado_id", empIds)
        .eq("descontado", false)
        .order("fecha", { ascending: true });
      setAdelantos((ads || []) as Adel[]);

      // Novedades existentes del mes (para inicializar el form).
      // Extendido 31-may: traer id+total+pagado de la liquidación para mostrar
      // el resumen de pago cuando la cuota está pagada (sin re-query).
      const { data: novs } = await db.from("rrhh_novedades")
        .select("id, empleado_id, mes, anio, cuota_num, cuotas_total, inasistencias, presentismo, horas_extras, dobles, feriados, otros_descuentos, otros_descuentos_motivo, observaciones, estado, rrhh_liquidaciones(id, estado, total_a_pagar, pagos_realizados)")
        .in("empleado_id", empIds)
        .eq("mes", mes).eq("anio", anio);
      type NovRow = NovDB & { rrhh_liquidaciones: { id: string; estado: string; total_a_pagar: number; pagos_realizados: number }[] | null };
      const novRows = (novs || []) as NovRow[];
      setNovedadesDB(novRows.map(({ rrhh_liquidaciones: _, ...n }) => n));
      const liqsArr: LiqEstado[] = novRows.map(n => {
        const ls = n.rrhh_liquidaciones || [];
        const liqPagada = ls.find(l => l.estado === "pagado");
        const liqAny = liqPagada ?? ls[0];
        return {
          empleado_id: n.empleado_id,
          cuota_num: n.cuota_num ?? 1,
          cuotas_total: n.cuotas_total ?? 1,
          estado: liqPagada ? "pagado" : "pendiente",
          liq_id: liqAny?.id ?? null,
          total_a_pagar: Number(liqAny?.total_a_pagar ?? 0),
          pagos_realizados: Number(liqAny?.pagos_realizados ?? 0),
        };
      });
      setLiqs(liqsArr);
    } else {
      setAdelantos([]); setNovedadesDB([]); setLiqs([]);
    }
    setLoading(false);
  }, [localId, mes, anio]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount/change, patrón estándar
  useEffect(() => { void recargar(); }, [recargar]);

  // Slots (1 por cuota: mensual=1, quincenal=2)
  const slots = useMemo(() => {
    const out: { emp: Emp; cuota: number; cuotasTotal: number; key: string }[] = [];
    for (const e of empleados) {
      const ct = e.modo_pago === "QUINCENAL" ? 2 : 1;
      for (let c = 1; c <= ct; c++) {
        out.push({ emp: e, cuota: c, cuotasTotal: ct, key: `${e.id}__${c}` });
      }
    }
    return out;
  }, [empleados]);

  // ── State editable + autosave ────────────────────────────────────────────
  const [novEdits, setNovEdits] = useState<Record<string, NovEdit>>({});
  // Mapa slotKey → estado de autosave
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  const [errorKeys, setErrorKeys] = useState<Set<string>>(new Set());

  // Inicializar novEdits desde novedades de DB (cuando se recarga)
  useEffect(() => {
    const next: Record<string, NovEdit> = {};
    for (const s of slots) {
      const n = novedadesDB.find(x =>
        x.empleado_id === s.emp.id &&
        (x.cuota_num ?? 1) === s.cuota &&
        (x.cuotas_total ?? 1) === s.cuotasTotal
      );
      next[s.key] = novDBaEdit(n);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- inicializar form al cargar/recargar novedades
    setNovEdits(next);
  }, [novedadesDB, slots]);

  // Debounce: guardar 800ms después del último tecleo por slot
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const guardarNovedad = useCallback(async (key: string) => {
    const slot = slots.find(s => s.key === key);
    if (!slot) return;
    const nov = novEdits[key];
    if (!nov) return;
    setSavingKeys(prev => new Set(prev).add(key));
    setErrorKeys(prev => { const n = new Set(prev); n.delete(key); return n; });
    try {
      // UPSERT por (empleado_id, mes, anio, cuota_num).
      // Estado='borrador' si no existía. Si ya estaba 'confirmado' (porque se
      // pagó), respetamos eso para no romper el resto del sistema.
      const existente = novedadesDB.find(n =>
        n.empleado_id === slot.emp.id &&
        n.mes === mes && n.anio === anio &&
        (n.cuota_num ?? 1) === slot.cuota
      );
      const payload = {
        empleado_id: slot.emp.id,
        mes, anio,
        cuota_num: slot.cuota,
        cuotas_total: slot.cuotasTotal,
        inasistencias: nov.inasistencias,
        presentismo: nov.presentismo_mantiene ? "MANTIENE" : "NO_MANTIENE",
        horas_extras: nov.horas_extras,
        dobles: nov.dobles,
        feriados: nov.feriados,
        otros_descuentos: nov.otros_desc,
        observaciones: nov.obs || null,
        // Si ya existe, no tocamos el estado (puede estar confirmado tras pago).
        // Si es nuevo, queda borrador.
        ...(existente ? {} : { estado: "borrador" }),
      };
      let error;
      if (existente) {
        const r = await db.from("rrhh_novedades").update(payload).eq("id", existente.id);
        error = r.error;
      } else {
        const r = await db.from("rrhh_novedades").insert(payload);
        error = r.error;
      }
      if (error) {
        setErrorKeys(prev => new Set(prev).add(key));
        showError("Autosave falló: " + translateRpcError(error));
      } else {
        setSavedAt(prev => ({ ...prev, [key]: Date.now() }));
        // Refrescar novedadesDB para que el próximo UPSERT use el id correcto.
        const { data: ns } = await db.from("rrhh_novedades")
          .select("id, empleado_id, mes, anio, cuota_num, cuotas_total, inasistencias, presentismo, horas_extras, dobles, feriados, otros_descuentos, otros_descuentos_motivo, observaciones, estado")
          .eq("empleado_id", slot.emp.id).eq("mes", mes).eq("anio", anio);
        setNovedadesDB(prev => {
          const otros = prev.filter(n => !(n.empleado_id === slot.emp.id && n.mes === mes && n.anio === anio));
          return [...otros, ...((ns || []) as NovDB[])];
        });
      }
    } finally {
      setSavingKeys(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  }, [slots, novEdits, novedadesDB, mes, anio, showError]);

  const updateNov = (key: string, field: keyof NovEdit, value: number | boolean | string) => {
    setNovEdits(prev => ({ ...prev, [key]: { ...(prev[key] || NOV_VACIA), [field]: value } }));
    // Re-arm debounce
    if (debounceTimers.current[key]) clearTimeout(debounceTimers.current[key]);
    debounceTimers.current[key] = setTimeout(() => { void guardarNovedad(key); }, 800);
  };

  // ── Adelantos: tildados por slot ─────────────────────────────────────────
  function adelantosDelSlot(empId: string, cuota: number, cuotasTotal: number) {
    const fin = fechaFinPeriodo(anio, mes, cuota, cuotasTotal);
    const ini = fechaInicioPeriodo(anio, mes, cuota, cuotasTotal);
    return adelantos.filter(a => a.empleado_id === empId).map(a => ({
      ...a, _entraPeriodo: a.fecha >= ini && a.fecha <= fin,
    }));
  }
  const [tildados, setTildados] = useState<Record<string, Set<string>>>({});
  useEffect(() => {
    const next: Record<string, Set<string>> = {};
    for (const s of slots) {
      // Cambio Lucas 31-may noche: los adelantos NUNCA se pre-tildan
      // automáticamente. El user los tilda manual desde la card o el modal
      // de pago. Esto elimina el comportamiento "auto_aplicar" y deja todos
      // los adelantos como saldo flotante hasta que el dueño decida cuándo
      // aplicarlos. La columna `auto_aplicar` queda en DB sin uso desde el
      // frontend (no se elimina por compat con historial viejo).
      const _adels = adelantosDelSlot(s.emp.id, s.cuota, s.cuotasTotal);
      void _adels;
      next[s.key] = new Set<string>();
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- inicializar set de tildados al recargar adelantos
    setTildados(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots.length, adelantos.length, mes, anio]);
  const toggleAdelanto = (slotKey: string, adelId: string) => {
    setTildados(prev => {
      const cur = new Set(prev[slotKey] || []);
      if (cur.has(adelId)) cur.delete(adelId); else cur.add(adelId);
      return { ...prev, [slotKey]: cur };
    });
  };

  // ── Estado de cada slot (pendiente/pagado) ───────────────────────────────
  function estadoSlot(empId: string, cuota: number): "pendiente" | "pagado" {
    const liq = liqs.find(l => l.empleado_id === empId && l.cuota_num === cuota);
    return liq?.estado === "pagado" ? "pagado" : "pendiente";
  }
  function liqDelSlot(empId: string, cuota: number): LiqEstado | undefined {
    return liqs.find(l => l.empleado_id === empId && l.cuota_num === cuota);
  }

  // ── Movimientos de pago (cargados cuando se expande una cuota pagada) ───
  // Mapa liq_id → array de movimientos. Lazy load: solo se fetchea cuando se
  // abre el card. Pedido Lucas 31-may: vista resumen de pago debe mostrar
  // fecha + medios + montos por cuenta.
  const [movsPorLiq, setMovsPorLiq] = useState<Record<string, MovPago[]>>({});
  const cargarMovsLiq = useCallback(async (liqId: string) => {
    if (movsPorLiq[liqId]) return;  // ya cargado
    const { data } = await db.from("movimientos")
      .select("id, liquidacion_id, cuenta, importe, fecha, anulado")
      .eq("liquidacion_id", liqId)
      .eq("anulado", false)
      .order("fecha", { ascending: true });
    setMovsPorLiq(prev => ({ ...prev, [liqId]: (data || []) as MovPago[] }));
  }, [movsPorLiq]);

  // ── Modal confirmación anular pago ──────────────────────────────────────
  const [anulModal, setAnulModal] = useState<{ liqId: string; empNom: string; total: number; movs: MovPago[]; modoEdit: boolean } | null>(null);
  const [anulando, setAnulando] = useState(false);
  const ejecutarAnular = async () => {
    if (!anulModal) return;
    setAnulando(true);
    try {
      // Anular cada movimiento de la liq (no anulado) vía RPC anular_movimiento,
      // que es la pieza atómica que revierte adelantos consumidos, aguinaldo,
      // y maneja partial-pay (último mov de la liq → revierte todo, otros →
      // solo resta importe de pagos_realizados). Ver migration
      // 202605141800_anular_pago_sueldo_revierte_todo.sql.
      for (const m of anulModal.movs) {
        const { error } = await db.rpc("anular_movimiento", {
          p_movimiento_id: m.id,
          p_motivo: anulModal.modoEdit
            ? `Anulado para editar sueldo (Anto cargó mal)`
            : `Anulado por dueño desde Sueldos`,
        });
        if (error) {
          showError(`Error anulando movimiento: ${translateRpcError(error)}`);
          return;
        }
      }
      showToast(anulModal.modoEdit ? "Pago anulado — ya podés editar" : "Pago anulado, plata devuelta a caja");
      setAnulModal(null);
      await recargar();
    } finally {
      setAnulando(false);
    }
  };

  // Empleados visibles (agrupados — 1 card por empleado)
  const empleadosVisibles = useMemo(() => {
    type Grupo = { emp: Emp; slots: typeof slots };
    const map = new Map<string, Grupo>();
    for (const s of slots) {
      const est = estadoSlot(s.emp.id, s.cuota);
      if (filtroEstado === "pendientes" && est !== "pendiente") continue;
      if (filtroEstado === "pagados" && est !== "pagado") continue;
      if (!map.has(s.emp.id)) map.set(s.emp.id, { emp: s.emp, slots: [] });
      map.get(s.emp.id)!.slots.push(s);
    }
    return Array.from(map.values());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, filtroEstado, liqs]);

  // Tab activo (Q1/Q2) por empleado cuando se expande
  const [cuotaTabPorEmp, setCuotaTabPorEmp] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (empId: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(empId)) next.delete(empId); else next.add(empId);
      return next;
    });
  };

  // Total a separar (suma de pendientes con su total estimado)
  const totalASeparar = useMemo(() => {
    return empleadosVisibles.reduce((acc, g) => acc + g.slots.reduce((s, slot) => {
      if (estadoSlot(slot.emp.id, slot.cuota) !== "pendiente") return s;
      const nov = novEdits[slot.key] || NOV_VACIA;
      const adels = adelantosDelSlot(slot.emp.id, slot.cuota, slot.cuotasTotal);
      const tildSet = tildados[slot.key] || new Set();
      const sumaAdel = adels.filter(a => tildSet.has(a.id)).reduce((sum, a) => sum + Number(a.monto), 0);
      return s + calcularTotal(slot.emp, nov, slot.cuotasTotal, slot.cuota, sumaAdel);
    }, 0), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empleadosVisibles, novEdits, tildados, adelantos]);

  // Navegación mes
  const goPrevMes = () => { if (mes === 1) { setMes(12); setAnio(anio - 1); } else setMes(mes - 1); };
  const goNextMes = () => { if (mes === 12) { setMes(1); setAnio(anio + 1); } else setMes(mes + 1); };

  // ── Modal "+ Adelanto" (real — RPC registrar_adelanto) ───────────────────
  const [adelModalSlot, setAdelModalSlot] = useState<string | null>(null);
  // auto_aplicar: ya no se usa desde frontend (Lucas 31-may: adelantos siempre
  // manuales). Lo mantengo en el state por compat de tipos, siempre false.
  const [adelForm, setAdelForm] = useState({ monto: "", fecha: toISO(today), cuenta: "", motivo: "" });
  const [guardandoAdel, setGuardandoAdel] = useState(false);
  const guardarAdelanto = async () => {
    if (!adelModalSlot) return;
    const parts = adelModalSlot.split("__");
    const empId = parts[0];
    if (!empId) return;
    const monto = parseFloat(adelForm.monto);
    if (!monto || monto <= 0 || !adelForm.cuenta) return;
    setGuardandoAdel(true);
    try {
      const { data, error } = await db.rpc("registrar_adelanto", {
        p_empleado_id: empId,
        p_monto: monto,
        p_cuenta: adelForm.cuenta,
        p_fecha: adelForm.fecha,
        p_detalle: adelForm.motivo || null,
      });
      if (error) { showError(translateRpcError(error)); return; }
      // Cambio Lucas 31-may noche: ya no se diferencia entre adelantos
      // "auto" y "manual". TODOS son manuales (saldo flotante). El INSERT
      // queda como vino del RPC; el flag auto_aplicar pierde sentido desde
      // el frontend.
      void data;
      showToast(`Adelanto registrado`);
      setAdelModalSlot(null);
      setAdelForm({ monto: "", fecha: toISO(today), cuenta: "", motivo: "" });
      await recargar();
    } finally {
      setGuardandoAdel(false);
    }
  };

  // ── Modal "Pagar" (real — RPC pagar_sueldo) ───────────────────────────────
  const [pagoSlot, setPagoSlot] = useState<string | null>(null);
  const [pagoLineas, setPagoLineas] = useState<{ cuenta: string; monto: string; local_id?: number | null }[]>([]);
  const [fechaPago, setFechaPago] = useState<string>(toISO(today));
  const [idempKey, setIdempKey] = useState<string>("");
  const [pagando, setPagando] = useState(false);

  const abrirPago = async (slotKey: string) => {
    const s = slots.find(x => x.key === slotKey);
    if (!s) return;
    // Antes de abrir el modal, forzamos un autosave pendiente si lo hay
    // (por si el user toca Pagar antes de los 800ms del debounce).
    if (debounceTimers.current[slotKey]) {
      clearTimeout(debounceTimers.current[slotKey]);
      delete debounceTimers.current[slotKey];
      await guardarNovedad(slotKey);
    }
    const nov = novEdits[slotKey] || NOV_VACIA;
    const adels = adelantosDelSlot(s.emp.id, s.cuota, s.cuotasTotal);
    const tildSet = tildados[slotKey] || new Set();
    const sumaAdel = adels.filter(a => tildSet.has(a.id)).reduce((sum, a) => sum + Number(a.monto), 0);
    const total = calcularTotal(s.emp, nov, s.cuotasTotal, s.cuota, sumaAdel);
    setPagoLineas([{ cuenta: cuentasUsables[0] || "", monto: String(total), local_id: s.emp.local_id }]);
    setFechaPago(toISO(today));
    setIdempKey(crypto.randomUUID());
    setPagoSlot(slotKey);
  };

  const confirmarPago = async () => {
    if (!pagoSlot) return;
    const s = slots.find(x => x.key === pagoSlot);
    if (!s) return;
    const nov = novEdits[pagoSlot] || NOV_VACIA;
    const adels = adelantosDelSlot(s.emp.id, s.cuota, s.cuotasTotal);
    const tildSet = tildados[pagoSlot] || new Set();
    const sumaAdel = adels.filter(a => tildSet.has(a.id)).reduce((sum, a) => sum + Number(a.monto), 0);
    const total = calcularTotal(s.emp, nov, s.cuotasTotal, s.cuota, sumaAdel);
    const adelIds = adels.filter(a => tildSet.has(a.id)).map(a => a.id);
    const formasValidas = pagoLineas
      .filter(fp => parseMonto(fp.monto) > 0 && !!fp.cuenta)
      .map(fp => {
        const base: { cuenta: string; monto: number; local_id?: number } = {
          cuenta: fp.cuenta, monto: parseMonto(fp.monto),
        };
        if (fp.local_id != null) base.local_id = fp.local_id;
        return base;
      });
    if (formasValidas.length === 0) { showError("Tenés que asignar al menos una forma de pago."); return; }

    // Buscar la novedad y su liquidación correspondiente
    const novDB = novedadesDB.find(n =>
      n.empleado_id === s.emp.id && n.mes === mes && n.anio === anio &&
      (n.cuota_num ?? 1) === s.cuota
    );
    if (!novDB) {
      showError("No encuentro la novedad. Cargá algún dato primero (faltas, extras o presentismo) y volvé a intentar.");
      return;
    }

    setPagando(true);
    try {
      // Cálculo unificado con calcularDesglose (mismo que muestra la pantalla
      // en vivo). Antes acá había una fórmula PARALELA hardcoded con bugs:
      //  - valorDia / cuotasTotal (faltas calculadas a la mitad)
      //  - presentismo sobre subtotal1 (no sobre sueldo mensual base)
      //  - presentismo sumado en Q1 quincenal (doble cobro)
      // Fix Lucas 31-may noche.
      const d = calcularDesglose(s.emp, nov, s.cuotasTotal, s.cuota, sumaAdel);
      const subtotal1 = d.baseCuota - d.descInas + d.ingrExtras + d.ingrDobles + d.ingrFeriados;
      const subtotal2 = subtotal1 + d.presentismo;

      const { data, error } = await db.rpc("pagar_sueldo", {
        p_nov_id: novDB.id,
        p_formas_pago: formasValidas,
        p_adelantos_ids: adelIds,
        p_fecha: fechaPago,
        p_mes: mes,
        p_anio: anio,
        p_crear_liq: true,
        p_calc: {
          sueldo_base: d.baseCuota,
          descuento_ausencias: d.descInas,
          total_horas_extras: d.ingrExtras,
          total_dobles: d.ingrDobles,
          total_feriados: d.ingrFeriados,
          subtotal1: Math.round(subtotal1),
          monto_presentismo: d.presentismo,
          subtotal2: Math.round(subtotal2),
          adelantos: d.totalAdelantos,
          otros_descuentos: d.otrosDesc,
          total_a_pagar: total,
          cuota_num: s.cuota,
          cuotas_total: s.cuotasTotal,
        },
        p_idempotency_key: idempKey,
        p_liq_id: null,
      });
      if (error) { showError(translateRpcError(error)); return; }
      const ok = (data && typeof data === "object" && "completa" in data && (data as { completa?: boolean }).completa === true);
      showToast(ok ? `Pago de ${s.emp.apellido} completado` : `Pago parcial de ${s.emp.apellido} registrado`);
      setPagoSlot(null);
      setPagoLineas([]);
      await recargar();
    } finally {
      setPagando(false);
    }
  };

  const slotPago = pagoSlot ? slots.find(s => s.key === pagoSlot) : null;
  const slotAdel = adelModalSlot ? slots.find(s => s.key === adelModalSlot) : null;
  const sumaLineasPago = pagoLineas.reduce((s, l) => s + (parseFloat(l.monto) || 0), 0);
  // Total pre-pago (con adelantos tildados ya descontados)
  const totalPago = (() => {
    if (!slotPago) return 0;
    const nov = novEdits[pagoSlot!] || NOV_VACIA;
    const adels = adelantosDelSlot(slotPago.emp.id, slotPago.cuota, slotPago.cuotasTotal);
    const tildSet = tildados[pagoSlot!] || new Set();
    const sumaAdel = adels.filter(a => tildSet.has(a.id)).reduce((sum, a) => sum + Number(a.monto), 0);
    return calcularTotal(slotPago.emp, nov, slotPago.cuotasTotal, slotPago.cuota, sumaAdel);
  })();

  return (
    <div>
      {toast && <ToastComponent toast={toast} />}
      {/* Toolbar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn btn-ghost btn-sm" onClick={goPrevMes} style={{ padding: "4px 10px" }}>←</button>
        <div style={{ padding: "5px 12px", background: "var(--s2)", borderRadius: 6, fontSize: 13, fontWeight: 500, minWidth: 130, textAlign: "center" }}>
          {nombreMes(mes)} {anio}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={goNextMes} style={{ padding: "4px 10px" }}>→</button>
        <div style={{ width: 1, height: 24, background: "var(--bd)", margin: "0 4px" }} />
        <select className="search" style={{ width: 170 }} value={localId ?? ""} onChange={e => setLocalId(parseInt(e.target.value))}>
          {!esEnc && <option value="">Seleccionar local…</option>}
          {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        {(["pendientes", "pagados", "todos"] as const).map(opt => (
          <button
            key={opt}
            className={`btn btn-sm ${filtroEstado === opt ? "btn-acc" : "btn-ghost"}`}
            onClick={() => setFiltroEstado(opt)}
            style={{ padding: "4px 12px", fontSize: 11 }}
          >
            {opt === "pendientes" ? "Pendientes" : opt === "pagados" ? "Pagados" : "Todos"}
          </button>
        ))}
      </div>

      {/* Strip resumen */}
      <div style={{
        padding: "10px 14px", marginBottom: 16, background: "var(--s2)", borderRadius: 8,
        display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap", fontSize: 12,
      }}>
        <span><strong>{empleadosVisibles.length}</strong> empleado{empleadosVisibles.length !== 1 ? "s" : ""}{filtroEstado !== "todos" ? ` con ${filtroEstado}` : ""}</span>
        {filtroEstado !== "pagados" && totalASeparar > 0 && (
          <span style={{
            padding: "3px 10px", borderRadius: 6,
            background: "rgba(34,197,94,0.10)",
            border: "1px solid rgba(34,197,94,0.25)",
            color: "var(--success)", fontWeight: 500,
          }}>
            A separar: {fmt_$(totalASeparar)}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--muted2)" }}>
          Cargar adelanto: usá "+ Adelanto" dentro de la card del empleado
        </span>
      </div>

      {/* Lista */}
      {!localId ? (
        <div className="alert alert-info">Elegí un local.</div>
      ) : loading ? (
        <div className="loading">Cargando…</div>
      ) : empleadosVisibles.length === 0 ? (
        <div className="empty">No hay empleados que coincidan con el filtro</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {/* eslint-disable-next-line react-hooks/refs -- debounceTimers.current solo se accede en event handlers (onChange/onClick), no durante render */}
          {empleadosVisibles.map(grupo => {
            const emp = grupo.emp;
            const cuotasTotal = grupo.slots[0]?.cuotasTotal ?? 1;
            const isExp = expanded.has(emp.id);
            const cuotasInfo = grupo.slots.map(s => {
              const nov = novEdits[s.key] || NOV_VACIA;
              const adels = adelantosDelSlot(s.emp.id, s.cuota, s.cuotasTotal);
              const tildSet = tildados[s.key] || new Set();
              const sumaAdel = adels.filter(a => tildSet.has(a.id)).reduce((sum, a) => sum + Number(a.monto), 0);
              const total = calcularTotal(s.emp, nov, s.cuotasTotal, s.cuota, sumaAdel);
              const estado = estadoSlot(s.emp.id, s.cuota);
              const venceFecha = fechaFinPeriodo(anio, mes, s.cuota, s.cuotasTotal);
              return { slot: s, nov, adels, tildSet, sumaAdel, total, estado, venceFecha };
            });
            const todasPagas = cuotasInfo.every(c => c.estado === "pagado");
            const cuotaActivaIdx = cuotaTabPorEmp[emp.id] ?? 0;
            const cuotaActiva = cuotasInfo[cuotaActivaIdx] ?? cuotasInfo[0];
            if (!cuotaActiva) return null;

            return (
              <div key={emp.id} className="panel" style={{
                padding: 0, overflow: "hidden",
                opacity: todasPagas ? 0.7 : 1,
              }}>
                {/* Header card */}
                <div
                  onClick={() => toggleExpand(emp.id)}
                  style={{
                    display: "grid", gridTemplateColumns: "22px 1fr 130px",
                    gap: 12, padding: "12px 16px", cursor: "pointer", alignItems: "center",
                    background: todasPagas ? "rgba(34,197,94,0.06)" : "transparent",
                  }}
                >
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>{isExp ? "▾" : "▸"}</span>
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>
                      {emp.apellido}, {emp.nombre}
                      <span style={{
                        marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 4,
                        background: "var(--pase-celeste-100)", color: "var(--acc)", fontWeight: 400,
                      }}>
                        {cuotasTotal === 1 ? "Mensual" : "Quincenal"} · {nombreMes(mes).toLowerCase()}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 2 }}>{emp.puesto}</div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: 11 }}>
                    {todasPagas ? (
                      <span className="badge b-success" style={{ fontSize: 10 }}>
                        {cuotasTotal === 1 ? "Mes pagado ✓" : "Mes completo ✓"}
                      </span>
                    ) : (
                      <span style={{ color: "var(--muted2)" }}>
                        {cuotasInfo.filter(c => c.estado === "pagado").length}/{cuotasInfo.length} pagada{cuotasInfo.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>

                {/* Sub-filas Q1/Q2 (o solo 1 si mensual) */}
                <div onClick={e => e.stopPropagation()}>
                  {cuotasInfo.map((c) => (
                    <div key={c.slot.key} style={{
                      display: "grid", gridTemplateColumns: "60px 1fr 130px 110px 110px",
                      gap: 12, padding: "10px 16px 10px 38px", alignItems: "center",
                      borderTop: "1px solid var(--bd)",
                      background: c.estado === "pagado" ? "rgba(34,197,94,0.04)" : "transparent",
                    }}>
                      <span style={{ fontSize: 11, fontWeight: 500, color: "var(--acc)" }}>
                        {labelSlot(c.slot.cuota, c.slot.cuotasTotal)}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--muted2)" }}>
                        vence {fmt_d(c.venceFecha)}
                      </span>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--acc)" }}>
                        {fmt_$(c.total)}
                      </div>
                      <div>
                        {c.estado === "pagado"
                          ? <span className="badge b-success" style={{ fontSize: 9 }}>Pagado</span>
                          : <span className="badge b-warn" style={{ fontSize: 9 }}>Pendiente</span>}
                      </div>
                      <div style={{ textAlign: "right" }}>
                        {c.estado === "pendiente" && esDueno && (
                          <button
                            className="btn btn-acc btn-sm"
                            onClick={() => abrirPago(c.slot.key)}
                            style={{ padding: "4px 12px", fontSize: 11 }}
                          >
                            Pagar →
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Body expandido — refactor compact (Lucas 31-may):
                    densidad alta, todo en menos verticalidad, info agrupada. */}
                {isExp && (() => {
                  const s = cuotaActiva.slot;
                  const nov = cuotaActiva.nov;
                  const adels = cuotaActiva.adels;
                  const tildSet = cuotaActiva.tildSet;
                  const sumaAdel = cuotaActiva.sumaAdel;
                  const isSaving = savingKeys.has(s.key);
                  const hasError = errorKeys.has(s.key);
                  const lastSaved = savedAt[s.key];
                  const savedAgoSec = lastSaved ? Math.floor((Date.now() - lastSaved) / 1000) : null;
                  const liqInfo = liqDelSlot(s.emp.id, s.cuota);
                  const isPagado = cuotaActiva.estado === "pagado";
                  const movsLiq = liqInfo?.liq_id ? (movsPorLiq[liqInfo.liq_id] ?? []) : [];
                  if (isPagado && liqInfo?.liq_id && !movsPorLiq[liqInfo.liq_id]) {
                    void cargarMovsLiq(liqInfo.liq_id);
                  }
                  const d = calcularDesglose(s.emp, nov, s.cuotasTotal, s.cuota, sumaAdel);
                  return (
                    <div style={{ borderTop: "1px solid var(--bd)", padding: "10px 16px 14px" }}>
                      {/* Tabs Q1/Q2 + banner pagado en una sola línea cuando se puede */}
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
                        {cuotasTotal > 1 ? (
                          <div style={{ display: "flex", gap: 3 }}>
                            {cuotasInfo.map((c, idx) => (
                              <button
                                key={c.slot.key}
                                onClick={() => setCuotaTabPorEmp(prev => ({ ...prev, [emp.id]: idx }))}
                                className={`btn btn-sm ${cuotaActivaIdx === idx ? "btn-acc" : "btn-ghost"}`}
                                style={{ padding: "3px 10px", fontSize: 10 }}
                              >
                                {labelSlot(c.slot.cuota, c.slot.cuotasTotal)}{c.estado === "pagado" && " ✓"}
                              </button>
                            ))}
                          </div>
                        ) : <div />}
                        {!isPagado && (
                          <span style={{ fontSize: 10, color: hasError ? "var(--danger)" : isSaving ? "var(--muted2)" : lastSaved ? "var(--success)" : "var(--muted2)" }}>
                            {hasError ? "⚠ sin guardar" : isSaving ? "guardando…" : lastSaved ? `✓ guardado${savedAgoSec! > 5 ? ` hace ${savedAgoSec}s` : ""}` : ""}
                          </span>
                        )}
                      </div>

                      {/* Banner pagado: una línea compacta con todo */}
                      {isPagado && liqInfo && (
                        <div style={{
                          background: "rgba(34,197,94,0.07)", border: "1px solid rgba(34,197,94,0.25)",
                          borderRadius: 6, padding: "6px 10px", marginBottom: 10,
                          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap",
                        }}>
                          <div style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 3, background: "var(--success)", color: "white", letterSpacing: 0.3 }}>PAGADO</span>
                            <span style={{ color: "var(--muted2)" }}>
                              <strong style={{ color: "var(--text)" }}>{fmt_$(liqInfo.pagos_realizados)}</strong>
                              {movsLiq.length > 0 && <> · {fmt_d(movsLiq[0]!.fecha)}</>}
                              {" · "}
                              {movsLiq.map(m => `${m.cuenta} ${fmt_$(Math.abs(Number(m.importe)))}`).join(" + ")}
                            </span>
                          </div>
                          {esDueno && liqInfo.liq_id && (
                            <div style={{ display: "flex", gap: 4 }}>
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{ padding: "2px 9px", fontSize: 10 }}
                                onClick={() => setAnulModal({
                                  liqId: liqInfo.liq_id!, empNom: `${emp.apellido} ${emp.nombre}`,
                                  total: liqInfo.pagos_realizados, movs: movsLiq, modoEdit: true,
                                })}
                              >
                                Editar
                              </button>
                              <button
                                className="btn btn-sec btn-sm"
                                style={{ padding: "2px 9px", fontSize: 10, color: "var(--danger)", borderColor: "var(--danger)" }}
                                onClick={() => setAnulModal({
                                  liqId: liqInfo.liq_id!, empNom: `${emp.apellido} ${emp.nombre}`,
                                  total: liqInfo.pagos_realizados, movs: movsLiq, modoEdit: false,
                                })}
                              >
                                Anular
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Grid principal 50/50 (antes 1.6/1) */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                        {/* COLUMNA IZQUIERDA: Novedades + Adelantos */}
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {/* Novedades — pagado: pills compactas. pendiente: inputs editables */}
                          {isPagado ? (
                            <div>
                              <div style={SECT_HD}>Novedades cargadas</div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                {nov.inasistencias > 0 && <Pill label="Faltas" value={nov.inasistencias} tone="danger" />}
                                {nov.horas_extras !== 0 && <Pill label="Hs extras" value={nov.horas_extras} tone="success" />}
                                {nov.dobles > 0 && <Pill label="Dobles" value={nov.dobles} tone="success" />}
                                {nov.feriados > 0 && <Pill label="Feriados" value={nov.feriados} tone="success" />}
                                {nov.otros_desc > 0 && <Pill label="Otros desc" value={fmt_$(nov.otros_desc)} tone="danger" />}
                                <Pill label="Presentismo" value={nov.presentismo_mantiene ? "sí" : "no"} tone={nov.presentismo_mantiene ? "success" : undefined} />
                                {nov.inasistencias === 0 && nov.horas_extras === 0 && nov.dobles === 0 && nov.feriados === 0 && nov.otros_desc === 0 && (
                                  <span style={{ fontSize: 10, color: "var(--muted2)" }}>Sin novedades extras</span>
                                )}
                              </div>
                            </div>
                          ) : (
                            <div>
                              <div style={SECT_HD}>Novedades de {labelSlot(s.cuota, s.cuotasTotal)}</div>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
                                <NovInput label="Faltas" value={nov.inasistencias} onChange={v => updateNov(s.key, "inasistencias", v)} />
                                <NovInput label="Hs extras" value={nov.horas_extras} onChange={v => updateNov(s.key, "horas_extras", v)} />
                                <NovInput label="Dobles" value={nov.dobles} onChange={v => updateNov(s.key, "dobles", v)} />
                                <NovInput label="Feriados" value={nov.feriados} onChange={v => updateNov(s.key, "feriados", v)} />
                                <NovInput label="Otros desc. $" value={nov.otros_desc} onChange={v => updateNov(s.key, "otros_desc", v)} />
                                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11, paddingTop: 12 }}>
                                  <input
                                    type="checkbox"
                                    checked={nov.presentismo_mantiene}
                                    onChange={e => updateNov(s.key, "presentismo_mantiene", e.target.checked)}
                                  />
                                  Presentismo
                                </label>
                              </div>
                            </div>
                          )}

                          {/* Adelantos */}
                          <div>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                              <div style={SECT_HD}>Adelantos</div>
                              {esDueno && !isPagado && (
                                <button
                                  className="btn btn-ghost btn-sm"
                                  onClick={() => setAdelModalSlot(s.key)}
                                  style={{ padding: "1px 8px", fontSize: 10 }}
                                >
                                  + Adelanto
                                </button>
                              )}
                            </div>
                            {adels.length === 0 ? (
                              <div style={{ fontSize: 10, color: "var(--muted2)" }}>Sin adelantos.</div>
                            ) : (
                              <div style={{ background: "var(--s2)", borderRadius: 6, padding: "4px 6px" }}>
                                {adels.map(a => {
                                  const tildado = tildSet.has(a.id);
                                  return (
                                    <label key={a.id} style={{
                                      display: "flex", alignItems: "center", gap: 7,
                                      fontSize: 10.5, padding: "3px 4px", borderRadius: 3,
                                      cursor: isPagado ? "default" : "pointer", opacity: tildado ? 1 : 0.55,
                                    }}>
                                      <input
                                        type="checkbox"
                                        checked={tildado}
                                        onChange={() => toggleAdelanto(s.key, a.id)}
                                        disabled={isPagado}
                                        style={{ width: 12, height: 12 }}
                                      />
                                      <span style={{ color: "var(--muted2)", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                        {fmt_d(a.fecha)} · {a.cuenta || "—"}
                                        {!a._entraPeriodo && (
                                          <span style={{
                                            marginLeft: 5, fontSize: 8, padding: "1px 4px", borderRadius: 2,
                                            background: "rgba(245,158,11,0.15)", color: "var(--warn)",
                                          }}>
                                            fuera período
                                          </span>
                                        )}
                                      </span>
                                      <span style={{ color: tildado ? "var(--danger)" : "var(--muted2)" }}>
                                        {tildado ? "−" : ""}{fmt_$(a.monto)}
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* COLUMNA DERECHA: Cálculo en vivo (más compacto) */}
                        <div>
                          <div style={SECT_HD}>{isPagado ? "Cálculo según novedades actuales" : "Cálculo en vivo"}</div>
                          <div style={{ background: "var(--s2)", borderRadius: 6, padding: "8px 10px", fontSize: 11 }}>
                            <DesgloseRow label="Sueldo base" value={fmt_$(d.baseCuota)} />
                            {nov.horas_extras > 0 && <DesgloseRow label={`+ ${nov.horas_extras} hs extra`} value={`+${fmt_$(d.ingrExtras)}`} tone="success" />}
                            {nov.dobles > 0 && <DesgloseRow label={`+ ${nov.dobles} dobles`} value={`+${fmt_$(d.ingrDobles)}`} tone="success" />}
                            {nov.feriados > 0 && <DesgloseRow label={`+ ${nov.feriados} feriados`} value={`+${fmt_$(d.ingrFeriados)}`} tone="success" />}
                            {nov.inasistencias > 0 && <DesgloseRow label={`− ${nov.inasistencias} faltas`} value={`−${fmt_$(d.descInas)}`} tone="danger" />}
                            {nov.presentismo_mantiene && d.presentismo > 0 && <DesgloseRow label="+ Presentismo 5%" value={`+${fmt_$(d.presentismo)}`} tone="success" />}
                            {nov.presentismo_mantiene && d.presentismo === 0 && s.cuotasTotal === 2 && s.cuota === 1 && <DesgloseRow label="Presentismo: se paga en Q2" value="—" />}
                            {nov.otros_desc > 0 && <DesgloseRow label="− Otros desc." value={`−${fmt_$(d.otrosDesc)}`} tone="danger" />}
                            {sumaAdel > 0 && <DesgloseRow label={`− Adelantos (${tildSet.size})`} value={`−${fmt_$(d.totalAdelantos)}`} tone="danger" />}
                            <div style={{
                              marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--bd)",
                              display: "flex", justifyContent: "space-between", alignItems: "baseline",
                            }}>
                              <span style={{ fontWeight: 500 }}>Total</span>
                              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--acc)" }}>{fmt_$(d.total)}</span>
                            </div>
                          </div>
                          {/* Aviso si pagado: cálculo vs pagado real puede diferir */}
                          {isPagado && Math.abs(d.total - liqInfo!.pagos_realizados) > 5 && (
                            <div style={{
                              marginTop: 6, fontSize: 10, color: "var(--warn)",
                              padding: "4px 8px", background: "rgba(245,158,11,0.08)", borderRadius: 4,
                            }}>
                              ⚠ Pagaron <strong>{fmt_$(liqInfo!.pagos_realizados)}</strong>, hoy calcula <strong>{fmt_$(d.total)}</strong> (las novedades cambiaron post-pago).
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal Adelanto */}
      <Modal
        isOpen={!!adelModalSlot}
        onClose={() => !guardandoAdel && setAdelModalSlot(null)}
        title={slotAdel ? `Adelanto a ${slotAdel.emp.apellido}` : "Adelanto"}
        maxWidth={480}
        preventCloseOnOverlay={guardandoAdel}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setAdelModalSlot(null)} disabled={guardandoAdel}>Cancelar</button>
            <button
              className="btn btn-acc"
              onClick={guardarAdelanto}
              disabled={guardandoAdel || !parseFloat(adelForm.monto) || !adelForm.cuenta}
            >
              {guardandoAdel ? "Registrando…" : "Registrar adelanto"}
            </button>
          </>
        }
      >
        <div className="form2">
          <div className="field">
            <label>Monto $</label>
            <input type="number" value={adelForm.monto} onChange={e => setAdelForm({ ...adelForm, monto: e.target.value })} placeholder="0" />
          </div>
          <div className="field">
            <label>Fecha</label>
            <input type="date" value={adelForm.fecha} onChange={e => setAdelForm({ ...adelForm, fecha: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label>Cuenta</label>
          <select value={adelForm.cuenta} onChange={e => setAdelForm({ ...adelForm, cuenta: e.target.value })}>
            <option value="">Elegí cuenta…</option>
            {cuentasUsables.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Motivo (opcional)</label>
          <input value={adelForm.motivo} onChange={e => setAdelForm({ ...adelForm, motivo: e.target.value })} placeholder="Ej: urgencia personal…" />
        </div>
        <div style={{
          fontSize: 11, color: "var(--muted2)", marginTop: 10, padding: "8px 12px",
          background: "var(--s2)", borderRadius: 6, lineHeight: 1.5,
        }}>
          ℹ️ El adelanto queda como <strong>saldo del empleado</strong>.
          Cuando vayas a pagar el sueldo, lo vas a ver con su fecha y monto —
          tildalo manualmente si querés descontarlo de ese pago.
        </div>
      </Modal>

      {/* Modal Pagar */}
      <Modal
        isOpen={!!pagoSlot}
        onClose={() => !pagando && setPagoSlot(null)}
        title={slotPago ? `Pagar — ${slotPago.emp.apellido}, ${slotPago.emp.nombre}` : "Pagar"}
        subtitle={slotPago ? `${labelSlot(slotPago.cuota, slotPago.cuotasTotal)} ${nombreMes(mes)} ${anio}` : ""}
        maxWidth={520}
        preventCloseOnOverlay={pagando}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setPagoSlot(null)} disabled={pagando}>Cancelar</button>
            <button
              className="btn btn-acc"
              onClick={confirmarPago}
              disabled={pagando || sumaLineasPago <= 0}
            >
              {pagando ? "Procesando…" : "Confirmar pago"}
            </button>
          </>
        }
      >
        {slotPago && (
          <>
            <div style={{
              padding: "10px 14px", background: "var(--s2)", borderRadius: 8,
              marginBottom: 14, display: "flex", justifyContent: "space-between",
            }}>
              <span style={{ fontSize: 12 }}>Total a pagar</span>
              <span style={{ fontSize: 18, fontWeight: 500, color: "var(--acc)" }}>{fmt_$(totalPago)}</span>
            </div>

            {(() => {
              const adels = adelantosDelSlot(slotPago.emp.id, slotPago.cuota, slotPago.cuotasTotal);
              const tildSet = tildados[pagoSlot!] || new Set();
              if (adels.length === 0) return null;
              return (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", marginBottom: 6 }}>
                    Adelantos a descontar
                  </div>
                  <div style={{ background: "var(--s2)", borderRadius: 8, padding: 10 }}>
                    {adels.map(a => {
                      const tildado = tildSet.has(a.id);
                      return (
                        <label key={a.id} style={{
                          display: "flex", alignItems: "center", gap: 10,
                          fontSize: 11, padding: "5px 6px", borderRadius: 4,
                          cursor: "pointer", opacity: tildado ? 1 : 0.55,
                        }}>
                          <input
                            type="checkbox"
                            checked={tildado}
                            onChange={() => toggleAdelanto(pagoSlot!, a.id)}
                          />
                          <span style={{ flex: 1, color: "var(--muted2)" }}>
                            {fmt_d(a.fecha)} · {a.cuenta || "—"}
                            {!a._entraPeriodo && <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "rgba(245,158,11,0.15)", color: "var(--warn)" }}>fuera del período</span>}
                          </span>
                          <span style={{ color: tildado ? "var(--danger)" : "var(--muted2)" }}>
                            {tildado ? "−" : ""}{fmt_$(a.monto)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", marginBottom: 6 }}>
              Fecha del movimiento
            </div>
            <input
              type="date"
              className="search"
              style={{ width: 180, marginBottom: 14 }}
              value={fechaPago}
              onChange={e => setFechaPago(e.target.value)}
            />

            <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", marginBottom: 6 }}>
              Formas de pago
            </div>
            {pagoLineas.map((l, i) => (
              <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <select
                  className="search"
                  style={{ flex: 1 }}
                  value={l.cuenta}
                  onChange={e => setPagoLineas(prev => prev.map((x, j) => j === i ? { ...x, cuenta: e.target.value } : x))}
                >
                  <option value="">Cuenta…</option>
                  {cuentasUsables.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input
                  type="number"
                  className="search"
                  style={{ width: 130 }}
                  value={l.monto}
                  onChange={e => setPagoLineas(prev => prev.map((x, j) => j === i ? { ...x, monto: e.target.value } : x))}
                />
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setPagoLineas(prev => prev.filter((_, j) => j !== i))}
                  style={{ padding: "0 10px" }}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setPagoLineas(prev => [...prev, { cuenta: "", monto: "0", local_id: slotPago.emp.local_id }])}
              style={{ marginBottom: 14 }}
            >
              + Agregar forma de pago
            </button>
            <div style={{
              display: "flex", justifyContent: "space-between",
              fontSize: 12, paddingTop: 10, borderTop: "1px solid var(--bd)",
            }}>
              <span style={{ color: "var(--muted2)" }}>Asignado en formas de pago</span>
              <span style={{ color: sumaLineasPago === totalPago ? "var(--success)" : "var(--warn)", fontWeight: 500 }}>
                {fmt_$(sumaLineasPago)} {sumaLineasPago === totalPago ? "✓" : `(faltan ${fmt_$(Math.max(0, totalPago - sumaLineasPago))})`}
              </span>
            </div>
          </>
        )}
      </Modal>

      {/* Modal Editar/Anular pago — pedido Lucas 31-may.
          Cuando el sueldo está pagado, los inputs están deshabilitados. Para
          modificarlo el dueño tiene que pasar primero por este modal que
          anula el/los movimientos en caja (devuelve plata) vía RPC
          anular_movimiento, que también revierte adelantos consumidos y
          aguinaldo. En "modo Editar" el flujo sigue con los inputs ya
          habilitados; en "modo Anular" simplemente queda pendiente. */}
      <Modal
        isOpen={!!anulModal}
        onClose={() => !anulando && setAnulModal(null)}
        title={anulModal?.modoEdit ? `Editar sueldo pagado — ${anulModal.empNom}` : `Anular pago — ${anulModal?.empNom}`}
        maxWidth={500}
        preventCloseOnOverlay={anulando}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setAnulModal(null)} disabled={anulando}>Cancelar</button>
            <button
              className="btn"
              style={{ background: "var(--danger)", color: "white", borderColor: "var(--danger)" }}
              onClick={ejecutarAnular}
              disabled={anulando}
            >
              {anulando ? "Anulando…" : anulModal?.modoEdit ? "Anular pago y editar" : "Sí, anular pago"}
            </button>
          </>
        }
      >
        {anulModal && (
          <>
            <div style={{
              padding: "12px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
              borderRadius: 8, marginBottom: 14, fontSize: 12, lineHeight: 1.5, color: "var(--text)",
            }}>
              {anulModal.modoEdit ? (
                <>⚠ <strong>Esto va a anular el pago en caja</strong> y devolver <strong>{fmt_$(anulModal.total)}</strong> a las cuentas de abajo. Después vas a poder editar las novedades y volver a pagarlo con el monto corregido.</>
              ) : (
                <>⚠ <strong>Esto va a devolver {fmt_$(anulModal.total)} a caja</strong> y dejar el sueldo en estado pendiente. Vas a tener que pagarlo de nuevo cuando quieras.</>
              )}
            </div>
            <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", marginBottom: 6 }}>
              Movimientos que se van a anular ({anulModal.movs.length})
            </div>
            <div style={{ background: "var(--s2)", borderRadius: 8, padding: 10 }}>
              {anulModal.movs.map(m => (
                <div key={m.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "4px 0" }}>
                  <span style={{ color: "var(--muted2)" }}>{m.cuenta} · {fmt_d(m.fecha)}</span>
                  <span style={{ color: "var(--text)" }}>+{fmt_$(Math.abs(Number(m.importe)))}</span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 8, lineHeight: 1.5 }}>
              También se revierten adelantos consumidos por este pago y, si era el último pago del mes, el aguinaldo acumulado.
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

// ── Helpers de estilo (compactar — Lucas 31-may) ────────────────────────────
const SECT_HD: import("react").CSSProperties = {
  fontSize: 9, color: "var(--muted)", textTransform: "uppercase",
  letterSpacing: 0.6, marginBottom: 5, fontWeight: 600,
};

// ── Sub-componentes ─────────────────────────────────────────────────────────
function NovInput({ label, value, onChange, disabled }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <label style={{ fontSize: 9, color: "var(--muted2)", letterSpacing: 0.3 }}>{label}</label>
      <input
        type="number"
        value={value}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        disabled={disabled}
        style={{
          fontSize: 12, padding: "4px 6px", textAlign: "right",
          background: "var(--bg)", border: "1px solid var(--bd)",
          color: "var(--text)", borderRadius: 4, width: "100%", boxSizing: "border-box",
        }}
      />
    </div>
  );
}
function DesgloseRow({ label, value, tone }: { label: string; value: string; tone?: "success" | "danger" }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "1.5px 0" }}>
      <span style={{ color: "var(--muted2)" }}>{label}</span>
      <span style={{ color: tone === "danger" ? "var(--danger)" : tone === "success" ? "var(--success)" : undefined }}>
        {value === "auto" ? "" : value}
      </span>
    </div>
  );
}
// Pill compacto para mostrar novedades read-only en una línea horizontal.
function Pill({ label, value, tone }: { label: string; value: string | number; tone?: "success" | "danger" }) {
  const color = tone === "danger" ? "var(--danger)" : tone === "success" ? "var(--success)" : "var(--muted2)";
  const bg = tone === "danger" ? "rgba(239,68,68,0.1)" : tone === "success" ? "rgba(34,197,94,0.1)" : "var(--s2)";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 10, padding: "2px 7px", borderRadius: 10,
      background: bg, color,
    }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}
