/* Tipos + lógica pura del drill-down del EERR (separado del componente modal
 * para no romper react-refresh: un archivo de componente solo exporta componentes). */
import type { LiquidacionConEmpleado } from "../types/rrhh";

/** Cómo encontrar los movimientos que componen una categoría según su sección. */
export interface DetalleDescriptor {
  /** tipo a filtrar en `gastos`; null = la sección no toma gastos (CMV). */
  gastoTipo: string | null;
  /** bucket a filtrar en `facturas`; null = no toma facturas normales. */
  facturaBucket: string | null;
  /** Modo CMV: facturas con cat=categoria y bucket null o "cat_compra". */
  cmv?: boolean;
  /** Modo Otros: gastos por categoría cuyo tipo NO es canónico. */
  otros?: boolean;
}

export interface BreakdownRow {
  label: string;
  monto: number;
  /** Resta (se muestra en rojo con signo −). */
  neg?: boolean;
  /** Línea de total/subtotal (separador arriba, peso 600). */
  big?: boolean;
}

export type DetalleState =
  | { tipo: "cat"; titulo: string; descriptor: DetalleDescriptor; categoria: string }
  | { tipo: "sueldo"; titulo: string; subtitulo: string; breakdown: BreakdownRow[]; total: number };

/** Resumen de novedades de un empleado: suma de sus liquidaciones del mes.
 *  Solo incluye las líneas con valor (≠0), salvo "Total a pagar" que siempre va. */
export function buildSueldoBreakdown(liqs: LiquidacionConEmpleado[]): BreakdownRow[] {
  const sum = (f: (l: LiquidacionConEmpleado) => number | undefined) =>
    liqs.reduce((s, l) => s + (f(l) || 0), 0);
  const rows: BreakdownRow[] = [];
  const push = (label: string, val: number, opts?: Partial<BreakdownRow>) => {
    if (val) rows.push({ label, monto: val, ...opts });
  };
  push("Sueldo base", sum(l => l.sueldo_base));
  push("Presentismo", sum(l => l.monto_presentismo));
  push("Horas extras", sum(l => l.total_horas_extras));
  push("Horas dobles", sum(l => l.total_dobles));
  push("Feriados", sum(l => l.total_feriados));
  push("Vacaciones", sum(l => l.total_vacaciones));
  push("Bono", sum(l => (l as { bono?: number }).bono));
  push("Ausencias", sum(l => l.descuento_ausencias), { neg: true });
  push("Adelantos", sum(l => l.adelantos), { neg: true });
  push("Otros descuentos", sum(l => (l as { otros_descuentos?: number }).otros_descuentos), { neg: true });
  rows.push({ label: "Total a pagar", monto: sum(l => l.total_a_pagar), big: true });
  push("Pagado", sum(l => l.pagos_realizados));
  return rows;
}
