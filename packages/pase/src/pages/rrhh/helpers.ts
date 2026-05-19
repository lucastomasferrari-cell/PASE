// Helpers y constantes del módulo RRHH. Extraídos de RRHH.tsx en F6 split
// (2026-05-11).

import type { CSSProperties } from "react";
import { calcularTotalLiquidacion } from "../../lib/calculos/rrhh";
import type { Empleado } from "../../types/rrhh";
import type { NovedadEditable } from "./types";

// Cálculo del valor del día doble: deriva del sueldo mensual del empleado
// (sueldo / 30 * 2). Antes existía una tabla rrhh_valores_doble que guardaba
// un valor fijo por puesto — eliminado porque dos empleados del mismo puesto
// pueden tener sueldos distintos. Liquidaciones ya persistidas conservan el
// valor histórico que se calculó en su momento; solo afecta cálculos nuevos.
export const calcularValorDoble = (emp: Pick<Empleado, "sueldo_mensual">): number =>
  (Number(emp.sueldo_mensual) || 0) / 30 * 2;

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

export const MESES_NOMBRE = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
export const MESES_SEL = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
export const PRESENTISMO_OPTS = [
  { value:"MANTIENE", label:"Tiene" },
  { value:"PIERDE", label:"No tiene" },
];
export const CUENTAS_PAGO = ["Caja Efectivo","Caja Chica","Caja Mayor","MercadoPago","Banco"];

export const inp: CSSProperties = { padding:"3px 5px", background:"var(--bg)", border:"1px solid var(--bd)", color:"var(--txt)", fontFamily:"'DM Mono',monospace", fontSize:10, borderRadius:"var(--r)", textAlign:"center" };
