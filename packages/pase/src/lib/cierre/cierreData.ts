import { money, pctOf, mesLabel, asignarColores, type ColoredSlice } from "./cierreCharts";

export interface MesResumenLite {
  ventas: number; cmv: number; gastosFijos: number; gastosVar: number;
  publicidad: number; comisiones: number; impuestos: number; otrosGastos: number;
  sueldos: number; cargasSociales: number; utilNeta: number;
}
export interface SocioLite { nombre: string; porcentaje: number; }
export interface CierreInput {
  localNombre: string; mes: string; emitido: string;
  ventas: number; cmv: number; utilBruta: number;
  gastosFijosVar: number; sueldos: number; cargas: number; boletas: number;
  publicidad: number; comisiones: number; impuestos: number; otros: number; utilNeta: number;
  porMedio: { label: string; value: number }[];
  cmvPorCat: { label: string; value: number }[];
  gastosPorCat: { label: string; value: number }[];
  // Desgloses de las otras categorías de egreso. Personal viene por empleado
  // (+ cargas + boletas como líneas), el resto por categoría.
  personalItems: { label: string; value: number }[];
  comisionesItems: { label: string; value: number }[];
  impuestosItems: { label: string; value: number }[];
  marketingItems: { label: string; value: number }[];
  prev: MesResumenLite | null;
  prevMes: string | null;
  socios: SocioLite[];
}

export interface ListItem { label: string; valueFmt: string; pct: string; }
export interface ChartSlice extends ColoredSlice { valueFmt: string; pct: string; }
/** Slide de desglose de una categoría de egreso (Personal, Comisiones, etc.). */
export interface BreakdownSection { titulo: string; pctVentas: string; prevPct: string | null; items: ListItem[]; chart: ChartSlice[]; totalFmt: string; }
export interface CierreModel {
  emitido: string;
  portada: { localNombre: string; mesLabel: string };
  ingresos: { totalFmt: string; prevLabel: string | null; prevFmt: string | null; items: ListItem[]; chart: ChartSlice[] };
  cmv: { pctVentas: string; prevPct: string | null; items: ListItem[]; chart: ChartSlice[]; totalFmt: string; utilBrutaPct: string };
  gastos: { pctVentas: string; prevPct: string | null; items: ListItem[]; chart: ChartSlice[]; totalFmt: string };
  // Desgloses extra (Personal, Comisiones, Impuestos, Marketing) — solo los que
  // tienen datos ese mes. Cada uno es una slide igual que CMV/Gastos.
  extras: BreakdownSection[];
  resumen: { lines: { label: string; pct: string; montoFmt: string }[]; totalGastosFmt: string; rentabilidadFmt: string; rentabilidadPct: string };
  division: { rentabilidadFmt: string; items: { nombre: string; pct: string; montoFmt: string }[] } | null;
}

function toList(items: { label: string; value: number }[], base: number): ListItem[] {
  return items.map((x) => ({ label: x.label, valueFmt: money(x.value), pct: pctOf(x.value, base) }));
}
function toChart(items: { label: string; value: number }[], base: number, maxSlices = 8): ChartSlice[] {
  return asignarColores(items, maxSlices).map((s) => ({ ...s, valueFmt: money(s.value), pct: pctOf(s.value, base) }));
}

export function assembleCierre(i: CierreInput): CierreModel {
  const v = i.ventas;
  const costoLaboral = i.sueldos + i.cargas + i.boletas;
  const totalGastos = v - i.utilNeta; // CMV + todos los egresos
  // El mes anterior solo sirve para comparar si REALMENTE tiene datos cargados.
  // Si no (ventas 0 = mes sin cargar), no mostramos la comparación (sería falsa).
  const prev = i.prev && i.prev.ventas > 0 ? i.prev : null;
  const prevVentas = prev?.ventas ?? 0;
  const prevGastosFV = prev ? prev.gastosFijos + prev.gastosVar : 0;

  // Desgloses de las otras categorías. Cada uno aparece SOLO si tiene datos.
  // pctVentas = peso de la categoría sobre las ventas; chart = % dentro de la
  // categoría (igual criterio que CMV/Gastos). prevPct compara contra el total
  // de esa categoría el mes anterior.
  const mkSection = (titulo: string, items: { label: string; value: number }[], prevTotal: number | null): BreakdownSection | null => {
    const total = items.reduce((s, x) => s + x.value, 0);
    if (total <= 0) return null;
    return {
      titulo,
      pctVentas: pctOf(total, v),
      prevPct: prev && prevTotal != null ? pctOf(prevTotal, prevVentas) : null,
      items: toList(items, v),
      chart: toChart(items, total),
      totalFmt: money(total),
    };
  };
  const extras: BreakdownSection[] = [
    mkSection("Egresos · Personal", i.personalItems, prev ? prev.sueldos + prev.cargasSociales : null),
    mkSection("Egresos · Comisiones", i.comisionesItems, prev ? prev.comisiones : null),
    mkSection("Egresos · Impuestos", i.impuestosItems, prev ? prev.impuestos : null),
    mkSection("Egresos · Marketing", i.marketingItems, prev ? prev.publicidad : null),
  ].filter((s): s is BreakdownSection => s !== null);

  const division = (i.socios.length > 0 && i.utilNeta > 0)
    ? {
        rentabilidadFmt: money(i.utilNeta),
        items: i.socios.map((s) => ({
          nombre: s.nombre,
          pct: s.porcentaje.toLocaleString("es-AR") + "%",
          montoFmt: money(i.utilNeta * s.porcentaje / 100),
        })),
      }
    : null;

  return {
    emitido: i.emitido,
    portada: { localNombre: i.localNombre, mesLabel: mesLabel(i.mes) },
    ingresos: {
      totalFmt: money(v),
      prevLabel: prev && i.prevMes ? mesLabel(i.prevMes) : null,
      prevFmt: prev ? money(prev.ventas) : null,
      items: toList(i.porMedio, v),
      chart: toChart(i.porMedio, v),
    },
    cmv: {
      pctVentas: pctOf(i.cmv, v),
      prevPct: prev ? pctOf(prev.cmv, prevVentas) : null,
      items: toList(i.cmvPorCat, v),
      chart: toChart(i.cmvPorCat, i.cmv),
      totalFmt: money(i.cmv),
      utilBrutaPct: pctOf(i.utilBruta, v),
    },
    gastos: {
      pctVentas: pctOf(i.gastosFijosVar, v),
      prevPct: prev ? pctOf(prevGastosFV, prevVentas) : null,
      items: toList(i.gastosPorCat, v),
      chart: toChart(i.gastosPorCat, i.gastosFijosVar),
      totalFmt: money(i.gastosFijosVar),
    },
    extras,
    resumen: {
      lines: [
        { label: "Gastos de marketing", pct: pctOf(i.publicidad, v), montoFmt: money(i.publicidad) },
        { label: "Gastos de personal", pct: pctOf(costoLaboral, v), montoFmt: money(costoLaboral) },
        { label: "Comisiones apps y bancos", pct: pctOf(i.comisiones, v), montoFmt: money(i.comisiones) },
        { label: "Impuestos", pct: pctOf(i.impuestos, v), montoFmt: money(i.impuestos) },
      ],
      totalGastosFmt: money(totalGastos),
      rentabilidadFmt: money(i.utilNeta),
      rentabilidadPct: pctOf(i.utilNeta, v),
    },
    division,
  };
}
