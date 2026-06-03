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
import { calcularTotalLiquidacion } from "../../lib/calculos/rrhh";
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
  presentismo: "MANTIENE" | "PIERDE" | null;
  horas_extras: number;
  dobles: number;
  feriados: number;
  vacaciones_dias: number | null;
  otros_descuentos: number | null;
  otros_descuentos_motivo: string | null;
  observaciones: string | null;
  estado: string;
  // F6 02-jun: plan de pago. NULL si no se cargó.
  monto_efectivo: number | null;
  monto_mp: number | null;
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
  vacaciones_dias: number;
  presentismo_mantiene: boolean;
  otros_desc: number;
  obs: string;
}
const NOV_VACIA: NovEdit = {
  inasistencias: 0, horas_extras: 0, dobles: 0, feriados: 0, vacaciones_dias: 0,
  presentismo_mantiene: true, otros_desc: 0, obs: "",
};
function novDBaEdit(n: NovDB | undefined): NovEdit {
  if (!n) return { ...NOV_VACIA };
  return {
    inasistencias: Number(n.inasistencias || 0),
    horas_extras: Number(n.horas_extras || 0),
    dobles: Number(n.dobles || 0),
    feriados: Number(n.feriados || 0),
    vacaciones_dias: Number(n.vacaciones_dias || 0),
    // BUG FIX 2026-06-01: el valor DB es 'PIERDE' (constraint migración
    // 202605142200). Antes leíamos != "NO_MANTIENE" → tratábamos 'PIERDE'
    // como MANTIENE → re-tildaba el checkbox después de uncheck. Ahora
    // explícito: solo false si DB tiene 'PIERDE', true en cualquier otro caso.
    presentismo_mantiene: n.presentismo !== "PIERDE",
    otros_desc: Number(n.otros_descuentos || 0),
    obs: n.observaciones || "",
  };
}

// Desglose del cálculo de un slot. Devuelve todos los componentes para
// poder mostrarlos en vivo en el panel derecho, no solo el total final.
// Refactor Lucas 31-may noche v3: delegamos en calcularTotalLiquidacion
// (la fórmula histórica completa). No duplicar lógica. Incluye plus
// vacacional, presentismo, todo.
interface DesgloseCalculo {
  baseCuota: number;
  descInas: number;
  ingrExtras: number;
  ingrDobles: number;
  ingrFeriados: number;
  plusVacacional: number;  // NUEVO: plus por días de vacaciones tomados
  presentismo: number;
  otrosDesc: number;
  totalAdelantos: number;
  total: number;
}
function calcularDesglose(emp: Emp, nov: NovEdit, cuotasTotal: number, cuotaNum: number, adelantosATildar: number): DesgloseCalculo {
  const modo_pago: "MENSUAL" | "QUINCENAL" = cuotasTotal === 2 ? "QUINCENAL" : "MENSUAL";
  // valor_doble = 1 día extra (sueldo/30). Coincide con helpers.ts:calcularValorDoble.
  const valor_doble = emp.sueldo_mensual / 30;
  const r = calcularTotalLiquidacion({
    sueldo_mensual: emp.sueldo_mensual,
    modo_pago,
    inasistencias: nov.inasistencias,
    horas_extras: nov.horas_extras,
    dobles: nov.dobles,
    valor_doble,
    feriados: nov.feriados,
    vacaciones_dias: nov.vacaciones_dias,
    presentismo_mantiene: nov.presentismo_mantiene,
    adelantos: adelantosATildar,
    pagos_dobles_realizados: 0,
    otros_descuentos: nov.otros_desc,
    cuota_num: cuotaNum,
    cuotas_total: cuotasTotal,
  });
  return {
    baseCuota: Math.round(r.sueldo_base),
    descInas: Math.round(r.descuento_ausencias),
    ingrExtras: Math.round(r.total_horas_extras),
    ingrDobles: Math.round(r.total_dobles),
    ingrFeriados: Math.round(r.total_feriados),
    plusVacacional: Math.round(r.total_vacaciones),
    presentismo: Math.round(r.monto_presentismo),
    otrosDesc: Math.round(nov.otros_desc),
    totalAdelantos: Math.round(adelantosATildar),
    total: Math.max(0, r.total_a_pagar),
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
        .select("id, empleado_id, mes, anio, cuota_num, cuotas_total, inasistencias, presentismo, horas_extras, dobles, feriados, vacaciones_dias, otros_descuentos, otros_descuentos_motivo, observaciones, estado, monto_efectivo, monto_mp, rrhh_liquidaciones(id, estado, total_a_pagar, pagos_realizados)")
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

  // Inicializar novEdits desde novedades de DB (cuando se recarga).
  //
  // BUG FIX 2026-06-01 (Anto): el useEffect pisaba el state local con valor
  // stale del DB cada vez que se ejecutaba el autosave de cualquier slot.
  // Escenarios reportados:
  //   1. "Se borra el número": user tipea "111" → debounce 800ms guarda →
  //      SELECT vuelve → mientras vuelve el user tipea "1111" → useEffect
  //      pisa el "1111" con el "111" stale del DB.
  //   2. "Sacar presentismo Q2 baja faltas Q1": SELECT trae AMBAS cuotas
  //      del empleado/mes/anio (Q1 stale + Q2 nuevo) → useEffect re-aplica
  //      ambas → Q1 que el user había editado pero no guardado se pisa con DB.
  //
  // Fix: SKIP slots que tienen debounce pending (user todavía tipeando) o
  // se están guardando ahora mismo. Solo refrescamos slots quiescentes.
  useEffect(() => {
    setNovEdits(prev => {
      const next: Record<string, NovEdit> = { ...prev };
      for (const s of slots) {
        // Skip si el user está editando activamente este slot
        const hayDebouncePending = !!debounceTimers.current[s.key];
        const seEstaGuardando = savingKeys.has(s.key);
        if (hayDebouncePending || seEstaGuardando) continue;

        const n = novedadesDB.find(x =>
          x.empleado_id === s.emp.id &&
          (x.cuota_num ?? 1) === s.cuota &&
          (x.cuotas_total ?? 1) === s.cuotasTotal
        );
        next[s.key] = novDBaEdit(n);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- inicializar form al cargar/recargar novedades
  }, [novedadesDB, slots, savingKeys]);

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
        // BUG FIX 2026-06-01: constraint DB (migración 202605142200)
        // acepta solo 'MANTIENE' o 'PIERDE'. Mandar 'NO_MANTIENE' fallaba
        // el UPDATE silencioso → useEffect post-fail pisaba el state con
        // valor stale del DB → checkbox re-tildaba solo.
        presentismo: nov.presentismo_mantiene ? "MANTIENE" : "PIERDE",
        horas_extras: nov.horas_extras,
        dobles: nov.dobles,
        feriados: nov.feriados,
        vacaciones_dias: nov.vacaciones_dias,
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
          .select("id, empleado_id, mes, anio, cuota_num, cuotas_total, inasistencias, presentismo, horas_extras, dobles, feriados, vacaciones_dias, otros_descuentos, otros_descuentos_motivo, observaciones, estado, monto_efectivo, monto_mp")
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
    debounceTimers.current[key] = setTimeout(() => {
      // BUG FIX 2026-06-01: limpiar el ref ANTES de guardar para que el
      // useEffect de refresh (que skipea slots con debounce pending) sepa
      // que ya no hay tipeo pendiente — solo hay save in-flight (que detecta
      // via savingKeys). Sin este delete, el ref quedaba siempre poblado
      // post-fire y el useEffect nunca refrescaba ese slot.
      delete debounceTimers.current[key];
      void guardarNovedad(key);
    }, 800);
  };

  // ── Confirmar / Modificar novedad (pedido Anto/Lucas 02-jun) ────────────
  // Anto carga novedades + adelantos a tildar y cuando termina toca
  // "Confirmar" para bloquear la card. Esto:
  //   1. Evita modificaciones accidentales después de revisar.
  //   2. Marca que ese sueldo está LISTO para pagar (Anto puede pagarlo
  //      el mismo día o más adelante).
  //   3. Permite que un futuro resumen pre-pago sume sólo los confirmados.
  // El estado 'confirmado' ya existía en `rrhh_novedades` (migration
  // 20260414) — sólo lo wireamos en la UI. Cuando se PAGA, queda
  // 'confirmado' igual y ahora el pago manda. Si se desconfirma post-pago,
  // no rompe nada (los movimientos siguen ahí).

  function isConfirmado(slotKey: string): boolean {
    const slot = slots.find(s => s.key === slotKey);
    if (!slot) return false;
    const nov = novedadesDB.find(n =>
      n.empleado_id === slot.emp.id &&
      n.mes === mes && n.anio === anio &&
      (n.cuota_num ?? 1) === slot.cuota
    );
    return nov?.estado === "confirmado";
  }

  const [togglingConfirm, setTogglingConfirm] = useState<Set<string>>(new Set());

  // ── Plan de pago por slot (Anto carga ANTES de confirmar) ───────────────
  // Estructura: { [slotKey]: { efectivo: string, mp: string } }
  // Se mantienen como string para que el input controlado no rompa al
  // borrar todo (sino quedaría "0" pegajoso). El parseo a número se hace
  // al confirmar y al sumar.
  const [planEdits, setPlanEdits] = useState<Record<string, { efectivo: string; mp: string }>>({});

  // Inicializar planEdits desde novedadesDB cuando carga.
  useEffect(() => {
    setPlanEdits(prev => {
      const next: Record<string, { efectivo: string; mp: string }> = { ...prev };
      for (const s of slots) {
        if (next[s.key]) continue; // ya hay edit en curso, no pisar
        const n = novedadesDB.find(x =>
          x.empleado_id === s.emp.id &&
          (x.cuota_num ?? 1) === s.cuota &&
          (x.cuotas_total ?? 1) === s.cuotasTotal
        );
        if (n && (n.monto_efectivo != null || n.monto_mp != null)) {
          next[s.key] = {
            efectivo: n.monto_efectivo != null ? String(Number(n.monto_efectivo)) : "",
            mp: n.monto_mp != null ? String(Number(n.monto_mp)) : "",
          };
        } else if (!next[s.key]) {
          next[s.key] = { efectivo: "", mp: "" };
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- inicializar form al cargar/recargar
  }, [novedadesDB, slots]);

  function updatePlan(key: string, campo: "efectivo" | "mp", valor: string) {
    setPlanEdits(prev => ({
      ...prev,
      [key]: { ...(prev[key] ?? { efectivo: "", mp: "" }), [campo]: valor },
    }));
  }

  function planTotalCargado(key: string): number {
    const p = planEdits[key];
    if (!p) return 0;
    return (parseFloat(p.efectivo) || 0) + (parseFloat(p.mp) || 0);
  }

  const confirmarSlot = useCallback(async (key: string) => {
    const slot = slots.find(s => s.key === key);
    if (!slot) return;
    setTogglingConfirm(prev => new Set(prev).add(key));
    try {
      // Si hay debounce pending, primero esperamos al autosave (sino la
      // versión confirmada quedaría con valores stale).
      if (debounceTimers.current[key]) {
        clearTimeout(debounceTimers.current[key]);
        delete debounceTimers.current[key];
        await guardarNovedad(key);
      }
      // Leer plan a guardar (puede ser 0 + 0 si no cargaron — válido).
      const plan = planEdits[key] ?? { efectivo: "", mp: "" };
      const efectivoNum = parseFloat(plan.efectivo) || 0;
      const mpNum = parseFloat(plan.mp) || 0;
      // Re-fetch para obtener el id de la novedad recién upserteada.
      const { data: ns } = await db.from("rrhh_novedades")
        .select("id, empleado_id, mes, anio, cuota_num, cuotas_total, inasistencias, presentismo, horas_extras, dobles, feriados, vacaciones_dias, otros_descuentos, otros_descuentos_motivo, observaciones, estado, monto_efectivo, monto_mp")
        .eq("empleado_id", slot.emp.id).eq("mes", mes).eq("anio", anio)
        .eq("cuota_num", slot.cuota);
      const existente = (ns ?? []).find(n => (n.cuota_num ?? 1) === slot.cuota);
      if (!existente) {
        // No había nada cargado — crear novedad vacía + plan + confirmar en una sola op.
        const { error } = await db.from("rrhh_novedades").insert({
          empleado_id: slot.emp.id, mes, anio,
          cuota_num: slot.cuota, cuotas_total: slot.cuotasTotal,
          inasistencias: 0, presentismo: "MANTIENE",
          horas_extras: 0, dobles: 0, feriados: 0,
          vacaciones_dias: 0, otros_descuentos: 0,
          monto_efectivo: efectivoNum, monto_mp: mpNum,
          estado: "confirmado",
        });
        if (error) { showError("No se pudo confirmar: " + translateRpcError(error)); return; }
      } else {
        const { error } = await db.from("rrhh_novedades")
          .update({
            estado: "confirmado",
            monto_efectivo: efectivoNum,
            monto_mp: mpNum,
          })
          .eq("id", existente.id);
        if (error) { showError("No se pudo confirmar: " + translateRpcError(error)); return; }
      }
      // Recargar para que isConfirmado() refleje el nuevo estado.
      await recargar();
    } finally {
      setTogglingConfirm(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  }, [slots, mes, anio, planEdits, guardarNovedad, recargar, showError]);

  const desconfirmarSlot = useCallback(async (key: string) => {
    const slot = slots.find(s => s.key === key);
    if (!slot) return;
    const existente = novedadesDB.find(n =>
      n.empleado_id === slot.emp.id &&
      n.mes === mes && n.anio === anio &&
      (n.cuota_num ?? 1) === slot.cuota
    );
    if (!existente) return;
    setTogglingConfirm(prev => new Set(prev).add(key));
    try {
      const { error } = await db.from("rrhh_novedades")
        .update({ estado: "borrador" }).eq("id", existente.id);
      if (error) { showError("No se pudo modificar: " + translateRpcError(error)); return; }
      await recargar();
    } finally {
      setTogglingConfirm(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  }, [slots, mes, anio, novedadesDB, recargar, showError]);

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

  // Totales de slots CONFIRMADOS (con plan de pago cargado) — pedido Anto/Lucas 02-jun.
  // Suma efectivo de todos los confirmados pendientes de pago + idem MP.
  // Esto le permite a Anto ver cuánto efectivo separar y cuánta transferencia
  // hacer ANTES de tocar Pagar.
  const { totalConfirmadoEfectivo, totalConfirmadoMP, countConfirmados } = useMemo(() => {
    let efe = 0, mp = 0, count = 0;
    for (const g of empleadosVisibles) {
      for (const slot of g.slots) {
        if (estadoSlot(slot.emp.id, slot.cuota) !== "pendiente") continue;
        const nov = novedadesDB.find(n =>
          n.empleado_id === slot.emp.id &&
          n.mes === mes && n.anio === anio &&
          (n.cuota_num ?? 1) === slot.cuota
        );
        if (nov?.estado !== "confirmado") continue;
        efe += Number(nov.monto_efectivo ?? 0);
        mp += Number(nov.monto_mp ?? 0);
        count++;
      }
    }
    return { totalConfirmadoEfectivo: efe, totalConfirmadoMP: mp, countConfirmados: count };
  }, [empleadosVisibles, novedadesDB, mes, anio]);

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

    // Pre-llenar con el plan confirmado si Anto cargó split efectivo/MP
    // antes (Lucas 02-jun). Si no hay plan, fallback al comportamiento
    // legacy: 1 línea con el total y la primera cuenta usable.
    const novDB = novedadesDB.find(n =>
      n.empleado_id === s.emp.id && n.mes === mes && n.anio === anio &&
      (n.cuota_num ?? 1) === s.cuota
    );
    const planEfe = novDB?.monto_efectivo != null ? Number(novDB.monto_efectivo) : 0;
    const planMp = novDB?.monto_mp != null ? Number(novDB.monto_mp) : 0;
    const hayPlan = (planEfe + planMp) > 0;

    if (hayPlan) {
      // Heurística para preseleccionar cuenta: buscar entre cuentasUsables
      // una que matchee el método. Si no encuentra, cae a primera disponible.
      const cuentaEfectivo = cuentasUsables.find(c => /efect/i.test(c)) ?? cuentasUsables[0] ?? "";
      const cuentaMP = cuentasUsables.find(c => /mp|mercado/i.test(c)) ?? cuentasUsables[1] ?? cuentasUsables[0] ?? "";
      const lineas: { cuenta: string; monto: string; local_id?: number | null }[] = [];
      if (planEfe > 0) lineas.push({ cuenta: cuentaEfectivo, monto: String(planEfe), local_id: s.emp.local_id });
      if (planMp > 0) lineas.push({ cuenta: cuentaMP, monto: String(planMp), local_id: s.emp.local_id });
      setPagoLineas(lineas);
    } else {
      setPagoLineas([{ cuenta: cuentasUsables[0] || "", monto: String(total), local_id: s.emp.local_id }]);
    }
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
      const subtotal1 = d.baseCuota - d.descInas + d.ingrExtras + d.ingrDobles + d.ingrFeriados + d.plusVacacional;
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
          total_vacaciones: d.plusVacacional,
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
        {/* Plan confirmado: efectivo + MP a separar antes de pagar */}
        {filtroEstado !== "pagados" && countConfirmados > 0 && (
          <>
            <span style={{ color: "var(--muted2)", fontSize: 11 }}>
              ✓ {countConfirmados} confirmado{countConfirmados !== 1 ? "s" : ""}:
            </span>
            {totalConfirmadoEfectivo > 0 && (
              <span
                title={`Efectivo a separar de los ${countConfirmados} confirmados`}
                style={{
                  padding: "3px 10px", borderRadius: 6,
                  background: "rgba(245,158,11,0.10)",
                  border: "1px solid rgba(245,158,11,0.30)",
                  color: "#d97706", fontWeight: 500,
                }}
              >
                💵 {fmt_$(totalConfirmadoEfectivo)}
              </span>
            )}
            {totalConfirmadoMP > 0 && (
              <span
                title={`Mercado Pago a transferir de los ${countConfirmados} confirmados`}
                style={{
                  padding: "3px 10px", borderRadius: 6,
                  background: "rgba(59,130,246,0.10)",
                  border: "1px solid rgba(59,130,246,0.30)",
                  color: "#2563eb", fontWeight: 500,
                }}
              >
                🏦 {fmt_$(totalConfirmadoMP)}
              </span>
            )}
          </>
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

                {/* Sub-filas Q1/Q2 (o solo 1 si mensual).
                    Si es quincenal Y el card está expandido, son CLICKEABLES
                    para cambiar entre Q1 y Q2 (reemplaza los tabs duplicados
                    que había antes en el body — pedido Lucas 31-may). */}
                <div onClick={e => e.stopPropagation()}>
                  {cuotasInfo.map((c, idx) => {
                    const esActivaEnExpand = isExp && cuotasTotal > 1 && cuotaActivaIdx === idx;
                    const subFilaCliqueable = isExp && cuotasTotal > 1;
                    return (
                      <div key={c.slot.key}
                        onClick={subFilaCliqueable ? () => setCuotaTabPorEmp(prev => ({ ...prev, [emp.id]: idx })) : undefined}
                        style={{
                          display: "grid", gridTemplateColumns: "60px 1fr 130px 110px 110px",
                          gap: 12, padding: "10px 16px 10px 38px", alignItems: "center",
                          borderTop: "1px solid var(--bd)",
                          borderLeft: esActivaEnExpand ? "3px solid var(--acc)" : "3px solid transparent",
                          background: esActivaEnExpand
                            ? "rgba(34,127,255,0.06)"
                            : c.estado === "pagado" ? "rgba(34,197,94,0.04)" : "transparent",
                          cursor: subFilaCliqueable ? "pointer" : "default",
                        }}>
                        <span style={{ fontSize: 11, fontWeight: esActivaEnExpand ? 600 : 500, color: "var(--acc)" }}>
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
                              onClick={e => { e.stopPropagation(); abrirPago(c.slot.key); }}
                              style={{ padding: "4px 12px", fontSize: 11 }}
                            >
                              Pagar →
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
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
                      {/* Indicador autosave (solo si no está pagado).
                          Antes acá había tabs Q1/Q2 — se quitaron por duplicidad
                          con las sub-filas (Lucas 31-may). Ahora las sub-filas
                          son clickeables para cambiar la cuota activa. */}
                      {!isPagado && (
                        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
                          <span style={{ fontSize: 10, color: hasError ? "var(--danger)" : isSaving ? "var(--muted2)" : lastSaved ? "var(--success)" : "var(--muted2)" }}>
                            {hasError ? "⚠ sin guardar" : isSaving ? "guardando…" : lastSaved ? `✓ guardado${savedAgoSec! > 5 ? ` hace ${savedAgoSec}s` : ""}` : ""}
                          </span>
                        </div>
                      )}

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
                                {nov.vacaciones_dias > 0 && <Pill label="Vacaciones" value={`${nov.vacaciones_dias} días`} tone="success" />}
                                {nov.otros_desc > 0 && <Pill label="Otros desc" value={fmt_$(nov.otros_desc)} tone="danger" />}
                                <Pill label="Presentismo" value={nov.presentismo_mantiene ? "sí" : "no"} tone={nov.presentismo_mantiene ? "success" : undefined} />
                                {nov.inasistencias === 0 && nov.horas_extras === 0 && nov.dobles === 0 && nov.feriados === 0 && nov.vacaciones_dias === 0 && nov.otros_desc === 0 && (
                                  <span style={{ fontSize: 10, color: "var(--muted2)" }}>Sin novedades extras</span>
                                )}
                              </div>
                            </div>
                          ) : (
                            <div>
                              <div style={SECT_HD}>Novedades {isConfirmado(s.key) && <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 6px", background: "rgba(34,197,94,0.15)", color: "var(--success)", borderRadius: 3, fontWeight: 600, letterSpacing: 0.3 }}>CONFIRMADAS</span>}</div>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, opacity: isConfirmado(s.key) ? 0.65 : 1 }}>
                                <NovInput label="Faltas" value={nov.inasistencias} onChange={v => updateNov(s.key, "inasistencias", v)} disabled={isConfirmado(s.key)} />
                                <NovInput label="Hs extras" value={nov.horas_extras} onChange={v => updateNov(s.key, "horas_extras", v)} disabled={isConfirmado(s.key)} />
                                <NovInput label="Dobles" value={nov.dobles} onChange={v => updateNov(s.key, "dobles", v)} disabled={isConfirmado(s.key)} />
                                <NovInput label="Feriados" value={nov.feriados} onChange={v => updateNov(s.key, "feriados", v)} disabled={isConfirmado(s.key)} />
                                <NovInput label="Vacaciones (días)" value={nov.vacaciones_dias} onChange={v => updateNov(s.key, "vacaciones_dias", v)} disabled={isConfirmado(s.key)} />
                                <NovInput label="Otros desc. $" value={nov.otros_desc} onChange={v => updateNov(s.key, "otros_desc", v)} disabled={isConfirmado(s.key)} />
                                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: isConfirmado(s.key) ? "not-allowed" : "pointer", fontSize: 11, paddingTop: 12, gridColumn: "1 / -1" }}>
                                  <input
                                    type="checkbox"
                                    checked={nov.presentismo_mantiene}
                                    onChange={e => updateNov(s.key, "presentismo_mantiene", e.target.checked)}
                                    disabled={isConfirmado(s.key)}
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
                              {esDueno && !isPagado && !isConfirmado(s.key) && (
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
                                  const bloqueadoAdel = isPagado || isConfirmado(s.key);
                                  return (
                                    <label key={a.id} style={{
                                      display: "flex", alignItems: "center", gap: 7,
                                      fontSize: 10.5, padding: "3px 4px", borderRadius: 3,
                                      cursor: bloqueadoAdel ? "default" : "pointer", opacity: tildado ? 1 : 0.55,
                                    }}>
                                      <input
                                        type="checkbox"
                                        checked={tildado}
                                        onChange={() => toggleAdelanto(s.key, a.id)}
                                        disabled={bloqueadoAdel}
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
                            {nov.vacaciones_dias > 0 && <DesgloseRow label={`+ ${nov.vacaciones_dias} días vacaciones (plus)`} value={`+${fmt_$(d.plusVacacional)}`} tone="success" />}
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

                      {/* Plan de pago + Confirmar / Modificar
                          (pedido Anto/Lucas 02-jun, refactor visual 03-jun).
                          Anto carga ANTES de pagar cuánto va en efectivo y
                          cuánto en MP. Suma debe coincidir con Total. */}
                      {!isPagado && esDueno && (() => {
                        const plan = planEdits[s.key] ?? { efectivo: "", mp: "" };
                        const cargado = planTotalCargado(s.key);
                        const total = d.total;
                        const dif = total - cargado;
                        const matchea = Math.abs(dif) < 0.01;
                        const confirmado = isConfirmado(s.key);
                        const inputStyle: React.CSSProperties = {
                          width: 140, padding: "7px 10px", fontSize: 13,
                          background: confirmado ? "var(--s2)" : "var(--bg, #0e1a2a)",
                          color: "var(--text, #e6ecf3)",
                          border: "1px solid var(--bd, #1e2d3f)",
                          borderRadius: 6,
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 500,
                          cursor: confirmado ? "not-allowed" : "text",
                          outline: "none",
                        };
                        return (
                          <div style={{
                            marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--bd)",
                          }}>
                            <div style={{
                              display: "flex", alignItems: "center", justifyContent: "center",
                              gap: 18, flexWrap: "wrap",
                              padding: "10px 12px",
                              background: "var(--s2)",
                              borderRadius: 8,
                            }}>
                              {/* Efectivo */}
                              <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                                <label style={{ fontSize: 11, color: "var(--muted2)", fontWeight: 500, display: "flex", alignItems: "center", gap: 4 }}>
                                  <span>💵</span> Efectivo
                                </label>
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  value={plan.efectivo}
                                  onChange={e => updatePlan(s.key, "efectivo", e.target.value)}
                                  disabled={confirmado || togglingConfirm.has(s.key)}
                                  placeholder="0"
                                  style={inputStyle}
                                />
                              </div>

                              {/* MP */}
                              <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                                <label style={{ fontSize: 11, color: "var(--muted2)", fontWeight: 500, display: "flex", alignItems: "center", gap: 4 }}>
                                  <span>🏦</span> Mercado Pago
                                </label>
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  value={plan.mp}
                                  onChange={e => updatePlan(s.key, "mp", e.target.value)}
                                  disabled={confirmado || togglingConfirm.has(s.key)}
                                  placeholder="0"
                                  style={inputStyle}
                                />
                              </div>

                              {/* Divider vertical */}
                              <div style={{ width: 1, height: 36, background: "var(--bd)" }} />

                              {/* Status compacto */}
                              <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-start", minWidth: 130 }}>
                                <span style={{ fontSize: 10, color: "var(--muted2)", textTransform: "uppercase", letterSpacing: 0.4 }}>
                                  Cargado / Total
                                </span>
                                <span style={{ fontSize: 13, fontWeight: 600, color: matchea ? "var(--success)" : "var(--warn)", fontVariantNumeric: "tabular-nums" }}>
                                  {matchea
                                    ? <>✓ {fmt_$(cargado)}</>
                                    : <>{fmt_$(cargado)} <span style={{ opacity: 0.6, fontWeight: 400 }}>/ {fmt_$(total)}</span></>}
                                </span>
                                {!matchea && (
                                  <span style={{ fontSize: 10, color: "var(--warn)", fontWeight: 500 }}>
                                    {dif > 0 ? `Falta ${fmt_$(Math.abs(dif))}` : `Excede en ${fmt_$(Math.abs(dif))}`}
                                  </span>
                                )}
                              </div>

                              {/* Acción */}
                              {confirmado ? (
                                <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
                                  <span style={{ fontSize: 11, color: "var(--success)", fontWeight: 500, whiteSpace: "nowrap" }}>
                                    ✓ Listo para pagar
                                  </span>
                                  <button
                                    className="btn btn-sec btn-sm"
                                    onClick={() => void desconfirmarSlot(s.key)}
                                    disabled={togglingConfirm.has(s.key)}
                                    style={{ padding: "6px 16px", fontSize: 12 }}
                                  >
                                    {togglingConfirm.has(s.key) ? "..." : "Modificar"}
                                  </button>
                                </div>
                              ) : (
                                <button
                                  className="btn btn-acc btn-sm"
                                  onClick={() => void confirmarSlot(s.key)}
                                  disabled={togglingConfirm.has(s.key) || isSaving || !matchea}
                                  title={!matchea
                                    ? "La suma de Efectivo + MP debe ser igual al Total."
                                    : "Bloquea los campos para evitar modificaciones accidentales."}
                                  style={{ padding: "6px 20px", fontSize: 12, marginLeft: "auto" }}
                                >
                                  {togglingConfirm.has(s.key) ? "Confirmando..." : "Confirmar"}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })()}
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
  // BUG FIX 2026-06-01 (Anto): el input se "borraba a 0" al tipear porque
  // `value={number}` re-renderizaba con cada cambio y `parseFloat || 0`
  // forzaba 0 ante CUALQUIER valor falsy (vacío, "1e", "-", ".", etc).
  // Pattern draft string: el input mantiene su propio estado visual mientras
  // está focused — solo sincroniza con el padre cuando pierde foco o cuando
  // el padre cambia y el user NO está editando (ej: cambio de slot).
  const [draft, setDraft] = useState<string>(value === 0 ? "" : String(value));
  const focusedRef = useRef(false);
  useEffect(() => {
    // Solo sync desde el padre si el user no está editando este input
    if (!focusedRef.current) {
      setDraft(value === 0 ? "" : String(value));
    }
  }, [value]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <label style={{ fontSize: 9, color: "var(--muted2)", letterSpacing: 0.3 }}>{label}</label>
      <input
        type="number"
        value={draft}
        placeholder="0"
        onFocus={() => { focusedRef.current = true; }}
        onBlur={() => {
          focusedRef.current = false;
          // Al perder foco, normalizamos y propagamos
          const n = parseFloat(draft);
          const final = isNaN(n) ? 0 : n;
          setDraft(final === 0 ? "" : String(final));
          if (final !== value) onChange(final);
        }}
        onChange={e => {
          const raw = e.target.value;
          setDraft(raw);
          // Propagar al padre solo si es parseable o vacío (para autosave)
          // No tocamos el padre con intermediate states tipo "1e" o "-"
          const n = parseFloat(raw);
          if (raw === "") onChange(0);
          else if (!isNaN(n) && isFinite(n)) onChange(n);
          // else: NaN/Infinity — esperamos al blur para normalizar
        }}
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
