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

/** Una línea del detalle por categoría: nombre (`c`) + total (`t`). */
export interface CategoriaRow {
  c: string;
  t: number;
}

/** Arma el detalle por categoría desde los datos REALES (no desde el catálogo),
 *  para que el detalle SIEMPRE cuadre con el total del grupo. Agrupa por la
 *  categoría de cada ítem (las vacías van a `sinCategoriaLabel`), descarta las
 *  de monto ~0, y ordena: primero las del catálogo (en su orden), después las
 *  categorías "huérfanas" (reales pero que no están en el catálogo) por monto
 *  desc. Bug 21-jun: antes el detalle se recorría desde el catálogo y se "comía"
 *  los gastos cuya categoría no estaba listada (ej: REPARTIDORES, Sueldo evento,
 *  PERSONAL) — sumaban al total del grupo pero no aparecían como línea. */
export function ordenarPorCategoria(
  items: Array<{ cat: string | null | undefined; monto: number }>,
  catalogo: string[],
  sinCategoriaLabel = "Sin categoría",
): CategoriaRow[] {
  const acc: Record<string, number> = {};
  for (const it of items) {
    const k = it.cat || sinCategoriaLabel;
    acc[k] = (acc[k] || 0) + Number(it.monto || 0);
  }
  const orden = new Map(catalogo.map((c, i) => [c, i] as const));
  return Object.entries(acc)
    .map(([c, t]) => ({ c, t }))
    .filter(x => Math.abs(x.t) > 0.005)
    .sort((a, b) => {
      const oa = orden.get(a.c);
      const ob = orden.get(b.c);
      if (oa !== undefined && ob !== undefined) return oa - ob;
      if (oa !== undefined) return -1;
      if (ob !== undefined) return 1;
      return b.t - a.t;
    });
}

/** Un adelanto/pago extra a un empleado, cargado como gasto de empleado fuera
 *  de la liquidación (ej: adelanto, feriado). */
export interface AdelantoEmpleado {
  fecha: string;   // "YYYY-MM-DD"
  monto: number;
  label: string;   // categoría del gasto (ej: "Adelanto", "Feriado")
}

const fechaCortaDM = (f: string): string => {
  const p = f.split("-");
  return p.length >= 3 ? `${p[2]}/${p[1]}` : f;
};

/** Resumen de novedades de un empleado: liquidación(es) del mes + los adelantos
 *  que se le pagaron por fuera. El "Total del mes" reconcilia el sueldo completo
 *  (lo de la liquidación + lo que ya cobró como adelanto). Solo incluye líneas
 *  con valor (≠0), salvo "Total a pagar" que siempre va. */
export function buildSueldoBreakdown(
  liqs: LiquidacionConEmpleado[],
  adelantos: AdelantoEmpleado[] = [],
): BreakdownRow[] {
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
  push("Adelantos (descontados)", sum(l => l.adelantos), { neg: true });
  push("Otros descuentos", sum(l => (l as { otros_descuentos?: number }).otros_descuentos), { neg: true });
  const totalLiq = sum(l => l.total_a_pagar);
  rows.push({ label: "Saldo en liquidación", monto: totalLiq, big: true });
  push("Pagado (liquidación)", sum(l => l.pagos_realizados));
  // Adelantos pagados por fuera: se muestran adentro del empleado y suman al
  // total del mes (antes quedaban sueltos en el total de Sueldos del P&L).
  if (adelantos.length) {
    let adeSum = 0;
    for (const a of adelantos) {
      adeSum += a.monto;
      push(`${a.label} ya pagado (${fechaCortaDM(a.fecha)})`, a.monto);
    }
    rows.push({ label: "Total del mes", monto: totalLiq + adeSum, big: true });
  }
  return rows;
}
