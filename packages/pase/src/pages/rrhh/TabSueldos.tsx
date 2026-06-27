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
import { calcularTotalLiquidacion, faltaSueldo } from "../../lib/calculos/rrhh";
import { useToast } from "../../hooks/useToast";
import { ToastComponent } from "../../components/Toast";
import { PrintRecibos } from "../../components/recibos/PrintRecibos";
import { construirReciboMensual, type ReciboSueldoModel, type MovParaRecibo, type ReciboNegocio, type LiqParaRecibo } from "../../lib/recibos";
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
  cuil?: string | null;
  fecha_inicio?: string | null;
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
  bono: number | null;
  bono_motivo: string | null;
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
// Etiqueta legible del concepto de un registro "YA PAGADO" (rrhh_adelantos).
// Cubre los conceptos que carga `crear_gasto_empleado` (Cargar Gasto → Empleados).
function conceptoLabel(c?: string | null): string {
  switch (c) {
    case "adelanto": return "Adelanto";
    case "dia_doble": return "Día doble";
    case "horas_extras": return "Horas extra";
    case "feriado": return "Feriado";
    case "comida": return "Comida";
    case "viatico": return "Viático";
    case "otros": return "Otros";
    default: return "Adelanto"; // registros viejos sin concepto
  }
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
  bono: number;
  obs: string;
}
const NOV_VACIA: NovEdit = {
  inasistencias: 0, horas_extras: 0, dobles: 0, feriados: 0, vacaciones_dias: 0,
  presentismo_mantiene: true, otros_desc: 0, bono: 0, obs: "",
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
    bono: Number(n.bono || 0),
    obs: n.observaciones || "",
  };
}

// ── Reconciliación novEdits ↔ DB (fix data-loss 2026-06-04) ─────────────────
// Re-sincroniza cada slot desde novedadesDB, EXCEPTO los que el usuario está
// editando activamente (touched). Esto evita que un slot quede "pegado" en 0
// (NOV_VACIA) cuando el init corrió con la DB todavía no cargada: los slots
// que el user no tocó SIEMPRE reflejan la base, así nunca se persisten 0s
// encima de la data real. Pura y testeable.
interface SlotKeyMin { key: string; empId: string; cuota: number; cuotasTotal: number }
// eslint-disable-next-line react-refresh/only-export-components -- helper puro exportado para testear; no es un componente
export function reconciliarNovEdits(
  prev: Record<string, NovEdit>,
  novedadesDB: NovDB[],
  slots: SlotKeyMin[],
  touched: ReadonlySet<string>,
): Record<string, NovEdit> {
  const next: Record<string, NovEdit> = { ...prev };
  for (const s of slots) {
    if (touched.has(s.key)) continue; // el user lo está editando → no pisar
    const n = novedadesDB.find(x =>
      x.empleado_id === s.empId &&
      (x.cuota_num ?? 1) === s.cuota &&
      (x.cuotas_total ?? 1) === s.cuotasTotal
    );
    next[s.key] = novDBaEdit(n); // re-sync SIEMPRE desde la DB (aunque ya exista)
  }
  return next;
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
  ingrBono: number;
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
    bono: nov.bono,
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
    ingrBono: Math.round(nov.bono),
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

  // ── Recibos imprimibles (Lucas 04-jun) ──────────────────────────────────
  const [reciboNegocioCfg, setReciboNegocioCfg] = useState<{ razon_social: string | null; cuit: string | null; direccion: string | null } | null>(null);
  const [reciboPrint, setReciboPrint] = useState<ReciboSueldoModel[] | null>(null);
  const [negocioModal, setNegocioModal] = useState(false);
  const [negocioForm, setNegocioForm] = useState({ razon_social: "", cuit: "", direccion: "" });
  const [imprimiendo, setImprimiendo] = useState(false);

  // Recargar todo (después de cualquier mutación)
  //
  // ⚠️ FIX DATA-LOSS 2026-06-04 (Lucas: "cargo, confirmo, vuelvo y me borra").
  // ANTES: setEmpleados corría ACÁ ARRIBA y setNovedadesDB MÁS ABAJO (después
  // de varios `await`). Como React NO batchea a través de un await, el render
  // intermedio tenía `slots` poblado pero `novedadesDB` viejo/vacío → el
  // useEffect de init inicializaba novEdits en 0 (NOV_VACIA) y el guard
  // `if (next[s.key]) continue` ya nunca re-sincronizaba con la DB real →
  // los inputs quedaban en 0 aunque la base tuviera los valores. Peor: si
  // sobre ese slot-en-0 se tocaba Pagar/Confirmar, persistirNovedad escribía
  // los 0 ENCIMA de la data real (pérdida de datos).
  // AHORA: hacemos TODOS los fetch primero y recién al final TODOS los
  // setState juntos (sin await en el medio) → un solo render con empleados +
  // novedadesDB consistentes → el init corre una vez con la data buena.
  const recargar = useCallback(async () => {
    if (!localId) return;
    setLoading(true);
    const { data: emps } = await db.from("rrhh_empleados")
      .select("id, nombre, apellido, puesto, sueldo_mensual, modo_pago, local_id, activo, alias_mp, cuil, fecha_inicio")
      .eq("activo", true)
      .eq("local_id", localId)
      .order("apellido");
    const empList = (emps || []) as Emp[];
    const empIds = empList.map(e => e.id);

    // Datos del negocio para los recibos (rrhh_recibo_config por local).
    const { data: cfg } = await db.from("rrhh_recibo_config")
      .select("razon_social, cuit, direccion").eq("local_id", localId).maybeSingle();

    let ads: Adel[] = [];
    let novDB: NovDB[] = [];
    let liqsArr: LiqEstado[] = [];
    if (empIds.length > 0) {
      // Cambio Lucas 31-may: traer TODOS los adelantos pendientes del empleado,
      // sin filtro de fecha (descontado=false ordenados por fecha).
      const { data: adsData } = await db.from("rrhh_adelantos")
        .select("id, empleado_id, fecha, monto, cuenta, descontado, auto_aplicar, concepto")
        .in("empleado_id", empIds)
        .eq("descontado", false)
        .order("fecha", { ascending: true });
      ads = (adsData || []) as Adel[];

      // Novedades existentes del mes (+ liquidación para el resumen de pago).
      const { data: novs } = await db.from("rrhh_novedades")
        .select("id, empleado_id, mes, anio, cuota_num, cuotas_total, inasistencias, presentismo, horas_extras, dobles, feriados, vacaciones_dias, otros_descuentos, otros_descuentos_motivo, bono, bono_motivo, observaciones, estado, monto_efectivo, monto_mp, rrhh_liquidaciones(id, estado, total_a_pagar, pagos_realizados)")
        .in("empleado_id", empIds)
        .eq("mes", mes).eq("anio", anio);
      type NovRow = NovDB & { rrhh_liquidaciones: { id: string; estado: string; total_a_pagar: number; pagos_realizados: number }[] | null };
      const novRows = (novs || []) as NovRow[];
      novDB = novRows.map(({ rrhh_liquidaciones: _, ...n }) => n);
      liqsArr = novRows.map(n => {
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
        } as LiqEstado;
      });
    }

    // ── Set TODO junto (sin await en el medio) → batched → init consistente ──
    setEmpleados(empList);
    setReciboNegocioCfg(cfg as { razon_social: string | null; cuit: string | null; direccion: string | null } | null);
    setAdelantos(ads);
    setNovedadesDB(novDB);
    setLiqs(liqsArr);
    setLoading(false);
  }, [localId, mes, anio]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount/change, patrón estándar
  useEffect(() => { void recargar(); }, [recargar]);

  // ── Recibos imprimibles (Lucas 04-jun) ──────────────────────────────────
  const negocioParaRecibo = (): ReciboNegocio => {
    const localNombre = locsDisp.find(l => l.id === localId)?.nombre ?? "";
    return {
      razonSocial: reciboNegocioCfg?.razon_social || localNombre || "—",
      cuit: reciboNegocioCfg?.cuit ?? null,
      direccion: reciboNegocioCfg?.direccion ?? null,
      sucursal: localNombre || null,
    };
  };

  const construirRecibosDeLiqs = async (liqIds: string[]): Promise<ReciboSueldoModel[]> => {
    if (liqIds.length === 0) return [];
    const { data: liqRows } = await db.from("rrhh_liquidaciones")
      .select("id, sueldo_base, total_horas_extras, total_dobles, total_feriados, total_vacaciones, monto_presentismo, descuento_ausencias, otros_descuentos, bono, adelantos, total_a_pagar, pagos_realizados, cuota_num, cuotas_total, pagado_at, rrhh_novedades(empleado_id, mes, anio)")
      .in("id", liqIds);
    const { data: movs } = await db.from("movimientos")
      .select("liquidacion_id, cuenta, importe").in("liquidacion_id", liqIds).eq("anulado", false);
    const movsPorLiq = new Map<string, MovParaRecibo[]>();
    for (const m of (movs || []) as { liquidacion_id: string; cuenta: string; importe: number }[]) {
      const arr = movsPorLiq.get(m.liquidacion_id) ?? [];
      arr.push({ cuenta: m.cuenta, importe: Number(m.importe) });
      movsPorLiq.set(m.liquidacion_id, arr);
    }
    const negocio = negocioParaRecibo();
    interface NovMin { empleado_id: string; mes: number; anio: number }
    type LiqRow = LiqParaRecibo & { id: string; pagado_at: string | null; rrhh_novedades: NovMin | NovMin[] | null };
    const out: ReciboSueldoModel[] = [];
    for (const row of (liqRows || []) as LiqRow[]) {
      const nov = Array.isArray(row.rrhh_novedades) ? row.rrhh_novedades[0] : row.rrhh_novedades;
      if (!nov) continue;
      const emp = empleados.find(e => e.id === nov.empleado_id);
      if (!emp) continue;
      out.push(construirReciboMensual({
        liq: row,
        movs: movsPorLiq.get(row.id) ?? [],
        empleado: { nombre: `${emp.apellido}, ${emp.nombre}`, cuil: emp.cuil ?? null, puesto: emp.puesto ?? null, ingreso: emp.fecha_inicio ?? null },
        negocio,
        mes: nov.mes, anio: nov.anio,
        modo: emp.modo_pago === "QUINCENAL" ? "Quincenal" : emp.modo_pago === "SEMANAL" ? "Semanal" : "Mensual",
        fechaPago: row.pagado_at,
      }));
    }
    return out;
  };

  const imprimirReciboLiq = async (liqId: string) => {
    setImprimiendo(true);
    try {
      const recibos = await construirRecibosDeLiqs([liqId]);
      if (recibos.length === 0) { showError("No se pudo armar el recibo."); return; }
      setReciboPrint(recibos);
    } finally { setImprimiendo(false); }
  };

  const imprimirTodosDelMes = async () => {
    const liqIds = liqs.filter(l => l.estado === "pagado" && l.liq_id).map(l => l.liq_id as string);
    if (liqIds.length === 0) { showError("No hay sueldos pagados este mes para imprimir."); return; }
    setImprimiendo(true);
    try { setReciboPrint(await construirRecibosDeLiqs(liqIds)); }
    finally { setImprimiendo(false); }
  };

  const abrirNegocioModal = () => {
    setNegocioForm({
      razon_social: reciboNegocioCfg?.razon_social ?? "",
      cuit: reciboNegocioCfg?.cuit ?? "",
      direccion: reciboNegocioCfg?.direccion ?? "",
    });
    setNegocioModal(true);
  };
  const guardarNegocio = async () => {
    if (!localId) return;
    const { error } = await db.from("rrhh_recibo_config").upsert({
      local_id: localId,
      razon_social: negocioForm.razon_social.trim() || null,
      cuit: negocioForm.cuit.trim() || null,
      direccion: negocioForm.direccion.trim() || null,
      tenant_id: _user.tenant_id,
      updated_at: new Date().toISOString(),
    }, { onConflict: "local_id" });
    if (error) { showError("No se pudo guardar: " + translateRpcError(error)); return; }
    showToast("Datos del negocio guardados");
    setNegocioModal(false);
    await recargar();
  };

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

  // ── State editable (SIN autosave) ────────────────────────────────────────
  // REWRITE 2026-06-04 (Lucas): eliminamos autosave entero. Cada keystroke
  // disparaba un UPSERT + SELECT que pisaba el state local del user mientras
  // seguía tipeando. Resultado: bugs imposibles de matar (el número volvía
  // al valor anterior, el -1 quedaba persistido, etc).
  //
  // Modelo nuevo (Lucas 04-jun): "esto solo se tiene que guardar cuando
  // pongo confirmar". Las novedades editadas viven SOLO en state local
  // (novEdits) hasta que el user toca **Confirmar** o **Pagar**. Recién
  // ahí se hace el UPSERT a DB. Si recarga la página sin confirmar, los
  // valores se pierden — eso es el comportamiento deseado.
  //
  // Esto elimina TODA la complejidad de:
  //   - Debounce timers
  //   - Saving keys / error keys / saved-at indicators
  //   - useEffect con guards anti-race
  //   - "✓ guardado" indicator
  //   - SELECT post-save que traía stale data
  const [novEdits, setNovEdits] = useState<Record<string, NovEdit>>({});
  // Slots que el usuario está editando en esta sesión. Los demás se
  // re-sincronizan SIEMPRE desde la DB (fix data-loss 04-jun) — ver
  // reconciliarNovEdits. Se limpian al Confirmar (para reflejar lo guardado)
  // y al cambiar mes/local (keys nuevas). Es un ref: no dispara renders.
  const touchedRef = useRef<Set<string>>(new Set());

  // Sincronizar novEdits con la DB. Los slots NO editados por el user reflejan
  // siempre novedadesDB; los que está editando se preservan. Esto impide que
  // un slot quede "pegado" en 0 cuando el init corre con la DB no cargada.
  useEffect(() => {
    setNovEdits(prev => reconciliarNovEdits(
      prev, novedadesDB,
      slots.map(s => ({ key: s.key, empId: s.emp.id, cuota: s.cuota, cuotasTotal: s.cuotasTotal })),
      touchedRef.current,
    ));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync form ↔ DB
  }, [novedadesDB, slots]);

  /**
   * Persiste el state local de una slot a DB.
   * Se invoca SOLO desde confirmarSlot() y abrirPago(). Nunca automáticamente.
   *
   * @param key slotKey
   * @param opts.estadoFinal estado a forzar (por defecto: respeta el actual si
   *   existe, sino 'borrador'). Confirmar fuerza 'confirmado'.
   * @returns id de la fila persistida, o null si error.
   */
  const persistirNovedad = useCallback(async (
    key: string,
    opts: { estadoFinal?: "borrador" | "confirmado" } = {},
  ): Promise<string | null> => {
    const slot = slots.find(s => s.key === key);
    if (!slot) return null;
    const existente = novedadesDB.find(n =>
      n.empleado_id === slot.emp.id &&
      n.mes === mes && n.anio === anio &&
      (n.cuota_num ?? 1) === slot.cuota
    );
    // Estado a guardar: lo que el user tiene en pantalla (novEdits). Si por la
    // mecánica de recargar/reconciliar ya se limpió (era undefined), NO fallar
    // en silencio — reconstruir desde la novedad de la DB (si existe) o vacío.
    // Antes: `if (!nov) return null` hacía que Confirmar/Pagar no guardaran
    // NADA sin avisar (bug Anto 07-jun: novedades que no se guardaban).
    const nov = novEdits[key] ?? (existente ? novDBaEdit(existente) : NOV_VACIA);
    const estadoFinal = opts.estadoFinal
      ?? (existente?.estado as ("borrador" | "confirmado") | undefined)
      ?? "borrador";
    const payload = {
      empleado_id: slot.emp.id,
      mes, anio,
      cuota_num: slot.cuota,
      cuotas_total: slot.cuotasTotal,
      // Sanitización: las novedades no pueden ser negativas. Si el user
      // escribió -1 (no debería poder con min=0 en el input, pero por las
      // dudas), lo forzamos a 0 acá antes de persistir.
      inasistencias: Math.max(0, nov.inasistencias || 0),
      presentismo: nov.presentismo_mantiene ? "MANTIENE" : "PIERDE",
      // Hs extras SÍ admite negativos (ajuste/descuento de horas — pedido
      // Lucas 04-jun). El resto de columnas siguen clampeadas a >= 0.
      horas_extras: nov.horas_extras || 0,
      dobles: Math.max(0, nov.dobles || 0),
      feriados: Math.max(0, nov.feriados || 0),
      vacaciones_dias: Math.max(0, nov.vacaciones_dias || 0),
      otros_descuentos: Math.max(0, nov.otros_desc || 0),
      bono: Math.max(0, nov.bono || 0),
      observaciones: nov.obs || null,
      estado: estadoFinal,
    };
    if (existente) {
      const { error } = await db.from("rrhh_novedades").update(payload).eq("id", existente.id);
      if (error) { showError("No se pudo guardar: " + translateRpcError(error)); return null; }
      return existente.id;
    }
    const { data, error } = await db.from("rrhh_novedades").insert(payload).select().single();
    if (error) { showError("No se pudo guardar: " + translateRpcError(error)); return null; }
    const nuevaFila = data as NovDB | null;
    if (nuevaFila) {
      // Agregar al state local de DB para que el próximo persist lo detecte como existente.
      setNovedadesDB(prev => [...prev, nuevaFila]);
      return nuevaFila.id;
    }
    return null;
  }, [slots, novEdits, novedadesDB, mes, anio, showError]);

  const updateNov = (key: string, field: keyof NovEdit, value: number | boolean | string) => {
    // SOLO state local. NO toca DB. La persistencia es al Confirmar/Pagar.
    // Marcar el slot como "tocado" para que reconciliarNovEdits NO lo pise con
    // la DB mientras el user lo edita.
    touchedRef.current.add(key);
    setNovEdits(prev => ({ ...prev, [key]: { ...(prev[key] || NOV_VACIA), [field]: value } }));
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
      // Persistir el state local actual con estado="confirmado".
      // Esto guarda TODOS los campos (faltas, hs extras, etc) + estado en
      // una sola operación. Reemplaza el flow viejo (autosave + UPDATE
      // estado = "confirmado" separado).
      const novId = await persistirNovedad(key, { estadoFinal: "confirmado" });
      if (!novId) return; // showError ya se mostró desde persistirNovedad

      // Plan de pago (split efectivo/MP). Si no cargaron nada, 0+0 es válido.
      const plan = planEdits[key] ?? { efectivo: "", mp: "" };
      const efectivoNum = parseFloat(plan.efectivo) || 0;
      const mpNum = parseFloat(plan.mp) || 0;
      const { error: errPlan } = await db.from("rrhh_novedades")
        .update({ monto_efectivo: efectivoNum, monto_mp: mpNum })
        .eq("id", novId);
      if (errPlan) { showError("No se pudo guardar plan de pago: " + translateRpcError(errPlan)); return; }

      // Limpiar el entry local de novEdits + el "tocado" para que el useEffect
      // lo re-sincronice desde DB (con los valores recién guardados +
      // estado=confirmado). Sin destildar touched, el slot quedaría preservado
      // con el state viejo y no reflejaría lo confirmado.
      touchedRef.current.delete(key);
      setNovEdits(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });

      // Recargar para que isConfirmado() refleje el nuevo estado.
      await recargar();
    } finally {
      setTogglingConfirm(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  }, [slots, planEdits, persistirNovedad, recargar, showError]);

  // ── Modal confirmación anular pago ──────────────────────────────────────
  // Declarado acá (antes de desconfirmarSlot) porque ese callback lo usa para
  // frenar la edición de un sueldo ya pagado y ofrecer anular primero.
  const [anulModal, setAnulModal] = useState<{ liqId: string; empNom: string; total: number; movs: MovPago[]; modoEdit: boolean; desconfirmarTras?: string } | null>(null);
  const [anulando, setAnulando] = useState(false);

  const desconfirmarSlot = useCallback(async (key: string) => {
    const slot = slots.find(s => s.key === key);
    if (!slot) return;
    const existente = novedadesDB.find(n =>
      n.empleado_id === slot.emp.id &&
      n.mes === mes && n.anio === anio &&
      (n.cuota_num ?? 1) === slot.cuota
    );
    if (!existente) return;
    // ★ Sprint anti-huérfanos (09-jun, pedido Lucas): si este sueldo YA tiene un
    // pago hecho, NO desbloquear a editar sin más. Frenar y ofrecer anular el
    // pago primero (modal "hay un pago realizado, ¿anularlo?"). Así nunca se
    // recalcula un sueldo pagado dejando movimientos colgados. El guard de la
    // base lo bloquea igual, pero acá lo resolvemos con UX en un solo paso.
    const liqInfo = liqs.find(l => l.empleado_id === slot.emp.id && l.cuota_num === slot.cuota);
    const estaPagado = liqInfo?.estado === "pagado" || Number(liqInfo?.pagos_realizados ?? 0) > 0;
    if (estaPagado && liqInfo?.liq_id) {
      const { data: movs } = await db.from("movimientos")
        .select("id, liquidacion_id, cuenta, importe, fecha, anulado")
        .eq("liquidacion_id", liqInfo.liq_id)
        .eq("anulado", false)
        .order("fecha", { ascending: true });
      setAnulModal({
        liqId: liqInfo.liq_id,
        empNom: `${slot.emp.apellido} ${slot.emp.nombre}`,
        total: liqInfo.pagos_realizados,
        movs: (movs || []) as MovPago[],
        modoEdit: true,
        desconfirmarTras: key,
      });
      return;
    }
    setTogglingConfirm(prev => new Set(prev).add(key));
    try {
      const { error } = await db.from("rrhh_novedades")
        .update({ estado: "borrador" }).eq("id", existente.id);
      if (error) { showError("No se pudo modificar: " + translateRpcError(error)); return; }
      // Re-sincronizar desde DB al modificar: el user arranca a editar desde
      // los valores guardados, no desde un state viejo.
      touchedRef.current.delete(key);
      await recargar();
    } finally {
      setTogglingConfirm(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  }, [slots, mes, anio, novedadesDB, liqs, recargar, showError]);

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
          p_mov_id: m.id,
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
      // Si esto vino del botón "Modificar" sobre un sueldo pagado, dejar la
      // novedad en borrador para que la card quede editable de una.
      const desconfKey = anulModal.desconfirmarTras;
      setAnulModal(null);
      if (desconfKey) {
        const slot = slots.find(s => s.key === desconfKey);
        const existente = slot && novedadesDB.find(n =>
          n.empleado_id === slot.emp.id && n.mes === mes && n.anio === anio &&
          (n.cuota_num ?? 1) === slot.cuota
        );
        if (existente) {
          await db.from("rrhh_novedades").update({ estado: "borrador" }).eq("id", existente.id);
          touchedRef.current.delete(desconfKey);
        }
      }
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
    // Persistir el state local actual antes de abrir el modal de pago.
    // Sin esto, los cambios visibles en pantalla (faltas, hs extras, etc)
    // no se incluyen en el cálculo del pago. NO cambia el estado de la
    // novedad — respeta lo que ya tenía (borrador o confirmado).
    await persistirNovedad(slotKey);
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

    // Si ya hubo un pago parcial (liquidación pendiente con pagos_realizados),
    // el default del pago es SOLO lo que falta — no el total entero. Evita el
    // doble pago (caso Alexia/Esteban: se volvía a pagar el sueldo completo).
    const liqExist = liqDelSlot(s.emp.id, s.cuota);
    const yaPagado = Math.round(Number(liqExist?.pagos_realizados ?? 0));
    // Falta = total EN VIVO − ya pagado (no el total_a_pagar congelado). faltaSueldo().
    const faltaPagar = faltaSueldo(total, yaPagado);
    const cuentaEfectivo = cuentasUsables.find(c => /efect/i.test(c)) ?? cuentasUsables[0] ?? "";
    const cuentaMP = cuentasUsables.find(c => /mp|mercado/i.test(c)) ?? cuentasUsables[1] ?? cuentasUsables[0] ?? "";

    if (yaPagado > 0) {
      // Pago parcial previo → una línea con lo que falta.
      setPagoLineas([{ cuenta: cuentaEfectivo, monto: String(faltaPagar), local_id: s.emp.local_id }]);
    } else if (hayPlan) {
      // Heurística para preseleccionar cuenta: buscar entre cuentasUsables
      // una que matchee el método. Si no encuentra, cae a primera disponible.
      const lineas: { cuenta: string; monto: string; local_id?: number | null }[] = [];
      if (planEfe > 0) lineas.push({ cuenta: cuentaEfectivo, monto: String(planEfe), local_id: s.emp.local_id });
      if (planMp > 0) lineas.push({ cuenta: cuentaMP, monto: String(planMp), local_id: s.emp.local_id });
      setPagoLineas(lineas);
    } else {
      setPagoLineas([{ cuenta: cuentasUsables[0] || "", monto: String(faltaPagar), local_id: s.emp.local_id }]);
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
    // BUG Esteban 07-jun: una línea con monto > 0 pero SIN cuenta seleccionada
    // se descartaba en silencio acá (filtro `!!fp.cuenta`), y el pago salía
    // parcial sin que nadie se enterara (el efectivo "se evaporaba"). Ahora
    // frenamos con un error claro en vez de descartarla.
    const lineasConMonto = pagoLineas.filter(fp => parseMonto(fp.monto) > 0);
    if (lineasConMonto.some(fp => !fp.cuenta)) {
      showError("Hay una línea de pago con monto pero sin cuenta seleccionada. Elegí la cuenta (o borrá la línea) antes de pagar.");
      return;
    }
    const formasValidas = lineasConMonto.map(fp => {
      const base: { cuenta: string; monto: number; local_id?: number } = {
        cuenta: fp.cuenta, monto: parseMonto(fp.monto),
      };
      if (fp.local_id != null) base.local_id = fp.local_id;
      return base;
    });
    if (formasValidas.length === 0) { showError("Tenés que asignar al menos una forma de pago."); return; }

    // Persistir la novedad ANTES de pagar y usar el id que devuelve. NO buscar
    // en novedadesDB (estado local que puede estar desactualizado y hacía que
    // el pago no encontrara la novedad o apuntara mal). Fix Anto 07-jun.
    const novId = await persistirNovedad(pagoSlot);
    if (!novId) { showError("No se pudo guardar la novedad antes de pagar. Reintentá."); return; }

    // Aviso de pago parcial: si lo asignado (formas de pago + adelantos) es
    // menor a lo que FALTA, confirmar explícitamente. Antes se registraba un
    // pago parcial en silencio y el empleado quedaba pendiente sin que nadie se
    // enterara (caso Dunstan/Alexia 07/08-jun). Se descuenta lo ya pagado para
    // que en un 2º pago el aviso compare contra el puchito pendiente, no el total.
    const liqYa = liqDelSlot(s.emp.id, s.cuota);
    const yaPagadoPrev = Math.round(Number(liqYa?.pagos_realizados ?? 0));
    // Lo que falta = total EN VIVO − ya pagado (no el congelado). faltaSueldo().
    const faltaPagarAhora = faltaSueldo(total, yaPagadoPrev);
    const totalAsignado = formasValidas.reduce((acc, f) => acc + f.monto, 0) + sumaAdel;

    if (totalAsignado < faltaPagarAhora - 1) {
      const ok = window.confirm(
        `Vas a pagar ${fmt_$(totalAsignado)} de ${fmt_$(faltaPagarAhora)} que falta de ${s.emp.apellido} ${s.emp.nombre}` +
        (yaPagadoPrev > 0 ? ` (ya se había pagado ${fmt_$(yaPagadoPrev)})` : "") + `.\n\n` +
        `Quedaría PENDIENTE ${fmt_$(faltaPagarAhora - totalAsignado)}.\n\n¿Seguro que querés pagar parcial?`
      );
      if (!ok) return;
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
        p_nov_id: novId,
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
          bono: d.ingrBono,
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
        <div style={{ width: 1, height: 24, background: "var(--bd)", margin: "0 4px" }} />
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => void imprimirTodosDelMes()}
          disabled={imprimiendo || !localId}
          style={{ padding: "4px 12px", fontSize: 11 }}
          title="Imprimir un recibo por cada sueldo pagado este mes"
        >
          🖨 Recibos del mes
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={abrirNegocioModal}
          disabled={!localId}
          style={{ padding: "4px 10px", fontSize: 11 }}
          title="Datos del negocio que salen en el recibo (razón social, CUIT, dirección)"
        >
          🏢 Datos
        </button>
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
            border: "0.5px solid rgba(34,197,94,0.25)",
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
                  border: "0.5px solid rgba(245,158,11,0.30)",
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
                  border: "0.5px solid rgba(59,130,246,0.30)",
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
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--acc)" }}>
                      {fmt_$(cuotasInfo.reduce((s, c) => s + c.total, 0))}
                    </div>
                    <div style={{ fontSize: 10, marginTop: 2 }}>
                      {todasPagas ? (
                        <span className="badge b-success" style={{ fontSize: 9 }}>
                          {cuotasTotal === 1 ? "Mes pagado ✓" : "Mes completo ✓"}
                        </span>
                      ) : (
                        <span style={{ color: "var(--muted2)" }}>
                          {cuotasInfo.filter(c => c.estado === "pagado").length}/{cuotasInfo.length} pagada{cuotasInfo.length !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
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
                          borderTop: "0.5px solid var(--bd)",
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
                  const liqInfo = liqDelSlot(s.emp.id, s.cuota);
                  const isPagado = cuotaActiva.estado === "pagado";
                  const movsLiq = liqInfo?.liq_id ? (movsPorLiq[liqInfo.liq_id] ?? []) : [];
                  if (isPagado && liqInfo?.liq_id && !movsPorLiq[liqInfo.liq_id]) {
                    void cargarMovsLiq(liqInfo.liq_id);
                  }
                  const d = calcularDesglose(s.emp, nov, s.cuotasTotal, s.cuota, sumaAdel);
                  // Indicador "guardando/✓ guardado" eliminado 2026-06-04
                  // junto con autosave entero. Ahora la novedad se persiste
                  // solo al tocar Confirmar/Pagar — sin estado intermedio.
                  return (
                    <div style={{ borderTop: "0.5px solid var(--bd)", padding: "10px 16px 14px" }}>

                      {/* Banner pagado: una línea compacta con todo */}
                      {isPagado && liqInfo && (
                        <div style={{
                          background: "rgba(34,197,94,0.07)", border: "0.5px solid rgba(34,197,94,0.25)",
                          borderRadius: 6, padding: "6px 10px", marginBottom: 10,
                          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap",
                        }}>
                          <div style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 9, fontWeight: 500, padding: "1px 6px", borderRadius: 3, background: "var(--success)", color: "white", letterSpacing: 0.3 }}>PAGADO</span>
                            <span style={{ color: "var(--muted2)" }}>
                              <strong style={{ color: "var(--text)" }}>{fmt_$(liqInfo.pagos_realizados)}</strong>
                              {movsLiq.length > 0 && <> · {fmt_d(movsLiq[0]!.fecha)}</>}
                              {" · "}
                              {movsLiq.map(m => `${m.cuenta} ${fmt_$(Math.abs(Number(m.importe)))}`).join(" + ")}
                            </span>
                          </div>
                          {liqInfo.liq_id && (
                            <div style={{ display: "flex", gap: 4 }}>
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{ padding: "2px 9px", fontSize: 10 }}
                                disabled={imprimiendo}
                                onClick={() => void imprimirReciboLiq(liqInfo.liq_id!)}
                                title="Imprimir recibo de sueldo"
                              >
                                🖨 Recibo
                              </button>
                              {esDueno && (
                                <>
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
                                </>
                              )}
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
                                {nov.horas_extras !== 0 && <Pill label="Hs extras" value={nov.horas_extras} tone={nov.horas_extras > 0 ? "success" : "danger"} />}
                                {nov.dobles > 0 && <Pill label="Dobles" value={nov.dobles} tone="success" />}
                                {nov.feriados > 0 && <Pill label="Feriados" value={nov.feriados} tone="success" />}
                                {nov.vacaciones_dias > 0 && <Pill label="Vacaciones" value={`${nov.vacaciones_dias} días`} tone="success" />}
                                {nov.otros_desc > 0 && <Pill label="Otros desc" value={fmt_$(nov.otros_desc)} tone="danger" />}
                                {nov.bono > 0 && <Pill label="Bono" value={fmt_$(nov.bono)} tone="success" />}
                                <Pill label="Presentismo" value={nov.presentismo_mantiene ? "sí" : "no"} tone={nov.presentismo_mantiene ? "success" : undefined} />
                                {nov.inasistencias === 0 && nov.horas_extras === 0 && nov.dobles === 0 && nov.feriados === 0 && nov.vacaciones_dias === 0 && nov.otros_desc === 0 && nov.bono === 0 && (
                                  <span style={{ fontSize: 10, color: "var(--muted2)" }}>Sin novedades extras</span>
                                )}
                              </div>
                            </div>
                          ) : (
                            <div>
                              <div style={SECT_HD}>Novedades {isConfirmado(s.key) && <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 6px", background: "rgba(34,197,94,0.15)", color: "var(--success)", borderRadius: 3, fontWeight: 500, letterSpacing: 0.3 }}>CONFIRMADAS</span>}</div>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, opacity: isConfirmado(s.key) ? 0.65 : 1 }}>
                                <NovInput label="Faltas" value={nov.inasistencias} onChange={v => updateNov(s.key, "inasistencias", v)} disabled={isConfirmado(s.key)} />
                                <NovInput label="Hs extras" value={nov.horas_extras} onChange={v => updateNov(s.key, "horas_extras", v)} disabled={isConfirmado(s.key)} allowNegative />
                                <NovInput label="Dobles" value={nov.dobles} onChange={v => updateNov(s.key, "dobles", v)} disabled={isConfirmado(s.key)} />
                                <NovInput label="Feriados" value={nov.feriados} onChange={v => updateNov(s.key, "feriados", v)} disabled={isConfirmado(s.key)} />
                                <NovInput label="Vacaciones (días)" value={nov.vacaciones_dias} onChange={v => updateNov(s.key, "vacaciones_dias", v)} disabled={isConfirmado(s.key)} />
                                <NovInput label="Otros desc. $" value={nov.otros_desc} onChange={v => updateNov(s.key, "otros_desc", v)} disabled={isConfirmado(s.key)} />
                                <NovInput label="Bonos $" value={nov.bono} onChange={v => updateNov(s.key, "bono", v)} disabled={isConfirmado(s.key)} />
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

                          {/* Ya pagado (adelantos + gastos a empleado de cualquier concepto) */}
                          <div>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                              <div style={SECT_HD}>Ya pagado</div>
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
                              <div style={{ fontSize: 10, color: "var(--muted2)" }}>Sin pagos previos.</div>
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
                                        <strong style={{ color: "var(--text)" }}>{conceptoLabel(a.concepto)}</strong> · {fmt_d(a.fecha)} · {a.cuenta || "—"}
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
                            {nov.horas_extras !== 0 && <DesgloseRow label={`${nov.horas_extras > 0 ? "+" : "−"} ${Math.abs(nov.horas_extras)} hs extra`} value={`${nov.horas_extras > 0 ? "+" : "−"}${fmt_$(Math.abs(d.ingrExtras))}`} tone={nov.horas_extras > 0 ? "success" : "danger"} />}
                            {nov.dobles > 0 && <DesgloseRow label={`+ ${nov.dobles} dobles`} value={`+${fmt_$(d.ingrDobles)}`} tone="success" />}
                            {nov.feriados > 0 && <DesgloseRow label={`+ ${nov.feriados} feriados`} value={`+${fmt_$(d.ingrFeriados)}`} tone="success" />}
                            {nov.vacaciones_dias > 0 && <DesgloseRow label={`+ ${nov.vacaciones_dias} días vacaciones (plus)`} value={`+${fmt_$(d.plusVacacional)}`} tone="success" />}
                            {nov.inasistencias > 0 && <DesgloseRow label={`− ${nov.inasistencias} faltas`} value={`−${fmt_$(d.descInas)}`} tone="danger" />}
                            {nov.presentismo_mantiene && d.presentismo > 0 && <DesgloseRow label="+ Presentismo 5%" value={`+${fmt_$(d.presentismo)}`} tone="success" />}
                            {nov.presentismo_mantiene && d.presentismo === 0 && s.cuotasTotal === 2 && s.cuota === 1 && <DesgloseRow label="Presentismo: se paga en Q2" value="—" />}
                            {nov.bono > 0 && <DesgloseRow label="+ Bono" value={`+${fmt_$(d.ingrBono)}`} tone="success" />}
                            {nov.otros_desc > 0 && <DesgloseRow label="− Otros desc." value={`−${fmt_$(d.otrosDesc)}`} tone="danger" />}
                            {sumaAdel > 0 && <DesgloseRow label={`− Ya pagado (${tildSet.size})`} value={`−${fmt_$(d.totalAdelantos)}`} tone="danger" />}
                            <div style={{
                              marginTop: 6, paddingTop: 6, borderTop: "0.5px solid var(--bd)",
                              display: "flex", justifyContent: "space-between", alignItems: "baseline",
                            }}>
                              <span style={{ fontWeight: 500 }}>Total</span>
                              <span style={{ fontSize: 15, fontWeight: 500, color: "var(--acc)" }}>{fmt_$(d.total)}</span>
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
                        // Si quedó un pago parcial, el "target" a cubrir es lo que
                        // FALTA (total del sueldo − ya pagado), no el total entero.
                        // Así se ve claro el puchito pendiente (pedido Anto 08-jun).
                        const liqSlot = liqDelSlot(s.emp.id, s.cuota);
                        const yaPagadoSlot = Math.round(Number(liqSlot?.pagos_realizados ?? 0));
                        // Total EN VIVO (recalculado con las novedades de hoy), NO el
                        // total_a_pagar congelado de la liq: si las novedades cambian
                        // post-pago, el "falta" se recalcula bien (no fantasma). faltaSueldo().
                        const totalSueldo = Math.round(d.total);
                        const total = faltaSueldo(d.total, yaPagadoSlot);
                        const dif = total - cargado;
                        // Pagar de MÁS está permitido (redondeo para arriba —
                        // en Argentina ya casi no hay billetes chicos). Pagar
                        // de MENOS sigue bloqueado. Pedido Lucas 04-jun.
                        const falta = dif > 0.01;        // cargado < total → bloquea Confirmar
                        const sobrepago = dif < -0.01;   // cargado > total → permite + warning
                        const exacto = !falta && !sobrepago;
                        const confirmado = isConfirmado(s.key);
                        const inputStyle: React.CSSProperties = {
                          width: 140, padding: "7px 10px", fontSize: 13,
                          background: confirmado ? "var(--s2)" : "var(--bg, #0e1a2a)",
                          color: "var(--text, #e6ecf3)",
                          border: "0.5px solid var(--bd, #1e2d3f)",
                          borderRadius: 6,
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          fontWeight: 500,
                          cursor: confirmado ? "not-allowed" : "text",
                          outline: "none",
                        };
                        return (
                          <div style={{
                            marginTop: 12, paddingTop: 12, borderTop: "0.5px solid var(--bd)",
                          }}>
                            {yaPagadoSlot > 0 && total > 0 && (
                              <div style={{
                                marginBottom: 10, padding: "7px 12px", borderRadius: 6,
                                background: "rgba(245,158,11,0.12)", border: "0.5px solid rgba(245,158,11,0.3)",
                                fontSize: 11.5, color: "var(--warn)", textAlign: "center",
                              }}>
                                ⚠ Pago parcial: ya se pagó <strong>{fmt_$(yaPagadoSlot)}</strong> de {fmt_$(totalSueldo)} ·
                                {" "}<strong>falta {fmt_$(total)}</strong> de este sueldo
                              </div>
                            )}
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
                                <span style={{ fontSize: 10, color: "var(--muted2)", textTransform: "none", letterSpacing: 0.4 }}>
                                  Cargado / Total
                                </span>
                                <span style={{ fontSize: 13, fontWeight: 500, color: exacto ? "var(--success)" : "var(--warn)", fontVariantNumeric: "tabular-nums" }}>
                                  {exacto
                                    ? <>✓ {fmt_$(cargado)}</>
                                    : <>{fmt_$(cargado)} <span style={{ opacity: 0.6, fontWeight: 400 }}>/ {fmt_$(total)}</span></>}
                                </span>
                                {falta && (
                                  <span style={{ fontSize: 10, color: "var(--warn)", fontWeight: 500 }}>
                                    Falta {fmt_$(Math.abs(dif))}
                                  </span>
                                )}
                                {sobrepago && (
                                  <span style={{ fontSize: 10, color: "var(--warn)", fontWeight: 500 }}>
                                    ⚠ Pagás {fmt_$(Math.abs(dif))} de más
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
                                  disabled={togglingConfirm.has(s.key)}
                                  title={falta
                                    ? "Confirma las novedades (no exige cargar el pago — eso es en 'Pagar')."
                                    : sobrepago
                                      ? "Vas a confirmar pagando de más (redondeo). El extra sale de la caja."
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
                  <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "none", marginBottom: 6 }}>
                    Ya pagado — tildá para descontar
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
                            <strong style={{ color: "var(--text)" }}>{conceptoLabel(a.concepto)}</strong> · {fmt_d(a.fecha)} · {a.cuenta || "—"}
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

            <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "none", marginBottom: 6 }}>
              Fecha del movimiento
            </div>
            <input
              type="date"
              className="search"
              style={{ width: 180, marginBottom: 14 }}
              value={fechaPago}
              onChange={e => setFechaPago(e.target.value)}
            />

            <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "none", marginBottom: 6 }}>
              Formas de pago
            </div>
            {locsDisp.length > 1 && (
              <div style={{ fontSize: 10, color: "var(--muted2)", marginBottom: 6 }}>
                Elegí de qué local sale cada parte (para repartir el pago entre sucursales).
              </div>
            )}
            {pagoLineas.map((l, i) => (
              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {/* Selector de local por línea — pago repartido entre sucursales.
                    Solo se muestra si el user tiene más de un local (dueño). */}
                {locsDisp.length > 1 && (
                  <select
                    className="search"
                    style={{ flex: 1, minWidth: 0 }}
                    value={l.local_id ?? ""}
                    onChange={e => setPagoLineas(prev => prev.map((x, j) => j === i ? { ...x, local_id: e.target.value ? parseInt(e.target.value) : null } : x))}
                    title="Local del que sale este pago"
                  >
                    {locsDisp.map(loc => <option key={loc.id} value={loc.id}>{loc.nombre}</option>)}
                  </select>
                )}
                <select
                  className="search"
                  style={{ flex: 1, minWidth: 0 }}
                  value={l.cuenta}
                  onChange={e => setPagoLineas(prev => prev.map((x, j) => j === i ? { ...x, cuenta: e.target.value } : x))}
                >
                  <option value="">Cuenta…</option>
                  {cuentasUsables.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input
                  type="number"
                  className="search"
                  style={{ width: 110 }}
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
              fontSize: 12, paddingTop: 10, borderTop: "0.5px solid var(--bd)",
            }}>
              <span style={{ color: "var(--muted2)" }}>Asignado en formas de pago</span>
              <span style={{ color: sumaLineasPago === totalPago ? "var(--success)" : "var(--warn)", fontWeight: 500 }}>
                {fmt_$(sumaLineasPago)}{" "}
                {sumaLineasPago === totalPago
                  ? "✓"
                  : sumaLineasPago > totalPago
                    ? `⚠ ${fmt_$(sumaLineasPago - totalPago)} de más`
                    : `(faltan ${fmt_$(totalPago - sumaLineasPago)})`}
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
              padding: "12px 14px", background: "rgba(239,68,68,0.08)", border: "0.5px solid rgba(239,68,68,0.25)",
              borderRadius: 8, marginBottom: 14, fontSize: 12, lineHeight: 1.5, color: "var(--text)",
            }}>
              {anulModal.modoEdit ? (
                <>⚠ <strong>Esto va a anular el pago en caja</strong> y devolver <strong>{fmt_$(anulModal.total)}</strong> a las cuentas de abajo. Después vas a poder editar las novedades y volver a pagarlo con el monto corregido.</>
              ) : (
                <>⚠ <strong>Esto va a devolver {fmt_$(anulModal.total)} a caja</strong> y dejar el sueldo en estado pendiente. Vas a tener que pagarlo de nuevo cuando quieras.</>
              )}
            </div>
            <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "none", marginBottom: 6 }}>
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

      {/* Vista de impresión de recibos (Lucas 04-jun) */}
      {reciboPrint && (
        <PrintRecibos recibos={reciboPrint} onClose={() => setReciboPrint(null)} />
      )}

      {/* Modal datos del negocio (recibos) */}
      <Modal
        isOpen={negocioModal}
        onClose={() => setNegocioModal(false)}
        title="Datos del negocio (recibos)"
        maxWidth={460}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setNegocioModal(false)}>Cancelar</button>
            <button className="btn btn-acc" onClick={guardarNegocio}>Guardar</button>
          </>
        }
      >
        <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 12 }}>
          Estos datos salen en el encabezado de los recibos de sueldo. Si los dejás vacíos, se usa el nombre del local.
        </div>
        <div className="field"><label>Razón social</label><input value={negocioForm.razon_social} onChange={e => setNegocioForm({ ...negocioForm, razon_social: e.target.value })} placeholder="Ej: Neko Sushi S.A." /></div>
        <div className="field"><label>CUIT</label><input value={negocioForm.cuit} onChange={e => setNegocioForm({ ...negocioForm, cuit: e.target.value })} placeholder="30-XXXXXXXX-X" /></div>
        <div className="field"><label>Dirección</label><input value={negocioForm.direccion} onChange={e => setNegocioForm({ ...negocioForm, direccion: e.target.value })} placeholder="Av. Corrientes 1234, CABA" /></div>
      </Modal>
    </div>
  );
}

// ── Helpers de estilo (compactar — Lucas 31-may) ────────────────────────────
const SECT_HD: import("react").CSSProperties = {
  fontSize: 9, color: "var(--muted)", textTransform: "none",
  letterSpacing: 0.6, marginBottom: 5, fontWeight: 500,
};

// ── Sub-componentes ─────────────────────────────────────────────────────────
function NovInput({ label, value, onChange, disabled, allowNegative }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean; allowNegative?: boolean }) {
  // REWRITE 2026-06-04 (Lucas): el bug reportado era cálculo en vivo desfasado
  // del input (input mostraba 0, cálculo decía "-1 faltas / -$33.333").
  //
  // Causa raíz: el draft local + focusedRef.current creaba 2 sources of truth.
  // Cuando el autosave guardaba un valor stale y el SELECT post-save traía
  // dato viejo, el padre se sync con DB pero el draft local del input quedaba
  // con el valor que el user tipeó. Resultado: input muestra X, cálculo lee Y.
  //
  // Fix: ELIMINAR el draft local. El input es 100% controlled por el padre.
  // El cálculo en vivo siempre coincide con lo que ves en el input porque
  // leen del mismo state.
  //
  // Trade-off: tipear "1." (decimal incompleto) puede mostrar "1" mientras
  // se procesa el ".". En la práctica no importa: estos campos son enteros
  // (faltas, horas, dobles, feriados, días vacaciones). El único decimal
  // posible es "Otros desc. $", y para tipear "1.5" no hay problema: cada
  // tecleo parsea como número válido y se muestra correctamente.
  const styleInput: import("react").CSSProperties = {
    fontSize: 12, padding: "4px 6px", textAlign: "right",
    background: "var(--bg)", border: "0.5px solid var(--bd)",
    color: "var(--text)", borderRadius: 4, width: "100%", boxSizing: "border-box",
  };

  // ── Modo negativo permitido (solo "Hs extras", pedido Lucas 04-jun) ──────
  // Un type=number controlado borra el "−" intermedio (el browser lo reporta
  // como "" hasta que hay un dígito, y al re-renderizar con value="" se pierde).
  // Por eso este caso usa type=text + un draft local mínimo. Es seguro: el
  // autosave ya no existe (eliminado 04-jun), así que el draft NO puede
  // reproducir el bug de desync — no hay SELECT que pise el state del padre.
  // El padre recibe el número parseado en cada tecleo válido.
  const [draft, setDraft] = useState<string>(value === 0 ? "" : String(value));
  const focusedRef = useRef(false);
  useEffect(() => {
    // Sincronizar desde el padre solo cuando el input NO está enfocado
    // (ej: confirmarSlot limpia novEdits, cambio de mes/local). Durante el
    // tipeo el padre ya está en sync con el draft, así que no pisamos.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync controlado padre→draft fuera de foco
    if (allowNegative && !focusedRef.current) setDraft(value === 0 ? "" : String(value));
  }, [value, allowNegative]);

  if (allowNegative) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <label style={{ fontSize: 9, color: "var(--muted2)", letterSpacing: 0.3 }}>{label}</label>
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          placeholder="0"
          onFocus={() => { focusedRef.current = true; }}
          onBlur={() => { focusedRef.current = false; setDraft(value === 0 ? "" : String(value)); }}
          onChange={e => {
            const raw = e.target.value;
            // Solo permitimos dígitos, un "-" inicial y un "." decimal.
            if (raw !== "" && !/^-?\d*\.?\d*$/.test(raw)) return;
            setDraft(raw);
            if (raw === "" || raw === "-" || raw === "." || raw === "-.") { onChange(0); return; }
            const n = parseFloat(raw);
            if (!isNaN(n) && isFinite(n)) onChange(n);
          }}
          disabled={disabled}
          style={styleInput}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <label style={{ fontSize: 9, color: "var(--muted2)", letterSpacing: 0.3 }}>{label}</label>
      <input
        type="number"
        min={0}
        value={value === 0 ? "" : String(value)}
        placeholder="0"
        onChange={e => {
          const raw = e.target.value;
          if (raw === "") {
            // Input vacío → 0
            onChange(0);
          } else {
            const n = parseFloat(raw);
            // Bloquea negativos: si el user escribe -1, lo forzamos a 0.
            // Esto + min={0} previenen el bug del 04-jun: -1 en faltas
            // generaba descuento negativo (= sumar dinero) en el cálculo.
            if (!isNaN(n) && isFinite(n) && n >= 0) onChange(n);
            else if (!isNaN(n) && n < 0) onChange(0);
            // Si no parsea (ej: "e", "."), ignoramos. Type=number filtra
            // la mayoría a nivel browser.
          }
        }}
        disabled={disabled}
        style={styleInput}
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
