// Helpers y constantes del módulo RRHH. Extraídos de RRHH.tsx en F6 split
// (2026-05-11).

import type { CSSProperties } from "react";
import { calcularTotalLiquidacion } from "../../lib/calculos/rrhh";
import type { Empleado } from "../../types/rrhh";
import type { NovedadEditable } from "./types";

// Cálculo del valor del día doble: deriva del sueldo mensual del empleado
// Un "turno doble" en gastronomía AR es trabajar 2 turnos consecutivos
// en el mismo día (almuerzo + cena). El sueldo mensual ya cubre 1 jornada
// por día → el doble se paga como 1 DÍA EXTRA encima (no 2 días).
// Antes calculábamos sueldo/30*2 (mal — pedido Anto 2026-05-19).
// Liquidaciones ya persistidas conservan su valor histórico.
export const calcularValorDoble = (emp: Pick<Empleado, "sueldo_mensual">): number =>
  (Number(emp.sueldo_mensual) || 0) / 30;

// Liquidación con efectivo/transferencia computados (lo que devuelve
// calcLiquidacion). Compatible con Liquidacion completa pero parcial porque
// no incluye id, novedad_id, etc. — el RPC los pone al persistir.
export type LiquidacionCalculada = ReturnType<typeof calcularTotalLiquidacion> & {
  efectivo: number;
  transferencia: number;
};

/**
 * Calcula la liquidación de una novedad.
 *
 * `adelantosOverride`: si está presente, sustituye `nov.adelantos`. Permite
 * que el TabNovedades use el monto real de adelantos pendientes (leídos
 * de rrhh_adelantos donde descontado=false en el mes) en lugar del campo
 * legacy nov.adelantos (que era un input libre sin link a la tabla real
 * de adelantos — bug detectado en auditoría 2026-05-14).
 *
 * Al confirmar la novedad, RRHH.tsx persiste nov.adelantos = adelantos
 * pendientes del mes en ese momento (snapshot), para que la liquidación
 * generada sea consistente con la fórmula.
 */
export function calcLiquidacion(emp: Empleado, nov: NovedadEditable, valorDoble: number, adelantosOverride?: number): LiquidacionCalculada {
  const adelantosFinal = adelantosOverride !== undefined ? adelantosOverride : (nov.adelantos || 0);
  // Bug reportado por Anto 21-may: Caro (QUINCENAL) salía con sueldo completo
  // porque modo_pago estaba hardcodeado a "MENSUAL". Ahora respeta emp.modo_pago.
  const modoPagoEmp = (emp.modo_pago === "QUINCENAL" || emp.modo_pago === "SEMANAL")
    ? emp.modo_pago
    : "MENSUAL";
  const result = calcularTotalLiquidacion({
    sueldo_mensual: emp.sueldo_mensual,
    modo_pago: modoPagoEmp,
    inasistencias: nov.inasistencias || 0,
    horas_extras: nov.horas_extras || 0,
    dobles: nov.dobles || 0,
    valor_doble: valorDoble,
    feriados: nov.feriados || 0,
    vacaciones_dias: nov.vacaciones_dias || 0,
    presentismo_mantiene: nov.presentismo === "MANTIENE",
    adelantos: adelantosFinal,
    pagos_dobles_realizados: 0,
    otros_descuentos: nov.otros_descuentos || 0,
  });
  return {
    ...result,
    efectivo: emp.alias_mp ? 0 : Math.max(result.total_a_pagar, 0),
    transferencia: emp.alias_mp ? Math.max(result.total_a_pagar, 0) : 0,
  };
}

// Acordado Lucas 21-may noche: cada quincena/semana es una novedad
// INDEPENDIENTE. El key en novMap es `${emp.id}__${cuota_num}`.
export const slotKey = (empId: string, cuotaNum: number) => `${empId}__${cuotaNum}`;

// Devuelve cuántas novedades genera un empleado según su modo de pago.
// QUINCENAL → 2 (Primera/Segunda Quincena). SEMANAL → 4 (1ra/2da/3ra/4ta semana).
// MENSUAL (default) → 1.
export function cuotasParaModoPago(modo: "MENSUAL" | "QUINCENAL" | "SEMANAL" | undefined | null): number {
  return modo === "QUINCENAL" ? 2 : modo === "SEMANAL" ? 4 : 1;
}

// Label visible para el slot ("Primera Quincena", "Segunda Quincena", "1ra semana", etc).
export function labelSlot(cuotaNum: number, cuotasTotal: number): string {
  if (cuotasTotal <= 1) return "";
  if (cuotasTotal === 2) return cuotaNum === 1 ? "Primera Quincena" : "Segunda Quincena";
  if (cuotasTotal === 4) return `${cuotaNum}ª Semana`;
  return `Cuota ${cuotaNum}/${cuotasTotal}`;
}

// Cuotas para multi-pago (modo_pago != MENSUAL).
// MENSUAL=1 cuota (fin de mes), QUINCENAL=2 (día 15 + fin), SEMANAL=4 (7/14/21/28).
// Decisión Lucas 2026-05-19: fechas fijas (no viernes flotantes) — más simple
// para conciliar a fin de mes.
export function calcularCuotas(
  modo_pago: "MENSUAL" | "QUINCENAL" | "SEMANAL" | undefined,
  mes: number,
  anio: number,
): { cuotas_total: number; vencimientos: string[] } {
  const cuotas_total = modo_pago === "QUINCENAL" ? 2 : modo_pago === "SEMANAL" ? 4 : 1;
  const lastDay = new Date(anio, mes, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateFor = (d: number) => `${anio}-${pad(mes)}-${pad(d)}`;
  let vencimientos: string[];
  if (cuotas_total === 1) {
    vencimientos = [dateFor(lastDay)];
  } else if (cuotas_total === 2) {
    vencimientos = [dateFor(15), dateFor(lastDay)];
  } else {
    vencimientos = [dateFor(7), dateFor(14), dateFor(21), dateFor(Math.min(28, lastDay))];
  }
  return { cuotas_total, vencimientos };
}

// Divide los componentes de una liquidación en N cuotas. Cada cuota es la
// Nava parte. La última cuota absorbe redondeo para que la suma cierre exacta.
// total_a_pagar redondea a entero; el resto queda como número (numeric en DB).
export function dividirEnCuotas(
  calc: LiquidacionCalculada,
  cuotas_total: number,
  vencimientos: string[],
  novedad_id: string,
): Array<Partial<LiquidacionCalculada> & {
  novedad_id: string;
  cuota_num: number;
  cuotas_total: number;
  fecha_vencimiento: string | null;
  estado: "pendiente";
  pagos_realizados: number;
  total_a_pagar: number;
  calculado_at: string;
}> {
  const divisor = cuotas_total;
  const totalEntero = Math.round(calc.total_a_pagar);
  const cuotaEntera = Math.round(totalEntero / divisor);
  const calculado_at = new Date().toISOString();
  return Array.from({ length: divisor }, (_, i) => {
    const cuota_num = i + 1;
    // Última cuota = total - suma de las anteriores. Garantiza cierre exacto.
    const total_a_pagar = cuota_num === divisor
      ? totalEntero - cuotaEntera * (divisor - 1)
      : cuotaEntera;
    return {
      novedad_id,
      sueldo_base: calc.sueldo_base / divisor,
      descuento_ausencias: calc.descuento_ausencias / divisor,
      total_horas_extras: calc.total_horas_extras / divisor,
      total_dobles: calc.total_dobles / divisor,
      total_feriados: calc.total_feriados / divisor,
      total_vacaciones: calc.total_vacaciones / divisor,
      subtotal1: calc.subtotal1 / divisor,
      monto_presentismo: calc.monto_presentismo / divisor,
      subtotal2: calc.subtotal2 / divisor,
      // Adelantos en cuota 1 únicamente (display info — el consume real
      // pasa al pagar via p_adelantos_ids).
      adelantos: cuota_num === 1 ? calc.adelantos : 0,
      pagos_realizados: 0,
      total_a_pagar,
      efectivo: calc.efectivo / divisor,
      transferencia: calc.transferencia / divisor,
      estado: "pendiente" as const,
      cuota_num,
      cuotas_total: divisor,
      fecha_vencimiento: vencimientos[i] ?? null,
      calculado_at,
    };
  });
}

export const MESES_NOMBRE = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
export const MESES_SEL = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
export const PRESENTISMO_OPTS = [
  { value:"MANTIENE", label:"Tiene" },
  { value:"PIERDE", label:"No tiene" },
];
export const CUENTAS_PAGO = ["Caja Efectivo","Caja Chica","Caja Mayor","MercadoPago","Banco"];

export const inp: CSSProperties = { padding:"3px 5px", background:"var(--bg)", border:"1px solid var(--bd)", color:"var(--txt)", fontFamily:"'DM Mono',monospace", fontSize:10, borderRadius:"var(--r)", textAlign:"center" };
