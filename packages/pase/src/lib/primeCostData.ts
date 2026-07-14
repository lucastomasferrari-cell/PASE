/* Carga de datos de PRIME COST (CMV + Costo laboral) para un mes + local.
 *
 * Prime Cost = Compras de mercadería (CMV) + Costo laboral (sueldos + cargas
 * sociales + boletas sindicales). Es el KPI #1 de gastronomía: lo que el dueño
 * controla día a día. Benchmark típico: ≤60% de ventas (verde), 60-65% (amarillo),
 * >65% (rojo).
 *
 * Esta función replica FIELMENTE el cálculo del EERR (pages/EERR.tsx, useEffect
 * de carga + derivaciones): mismas queries, mismo filtrado por local vía los
 * movimientos de sueldo, misma clasificación CMV (bucket NULL/'cat_compra') y
 * misma composición del costo laboral. Se extrajo acá para que la pantalla
 * Prime Cost dé números IDÉNTICOS a Reportes sin duplicar la lógica.
 *
 * ⚠️ Si cambia la fórmula del costo laboral / CMV en EERR.tsx, actualizar acá
 * también (o migrar EERR a consumir esta función).
 */
import { db } from "./supabase";
import { applyLocalScope } from "./auth";
import type { Usuario } from "../types/auth";
import type { Factura, Venta, Gasto } from "../types/finanzas";
import type { LiquidacionConEmpleado } from "../types/rrhh";
import type { AdelantoEmpleado } from "../pages/eerrDetalle";

type EmpMin = NonNullable<NonNullable<LiquidacionConEmpleado["rrhh_novedades"]>["rrhh_empleados"]>;

export interface EmpleadoLaborRow {
  emp: EmpMin;
  liqs: LiquidacionConEmpleado[];
  ade: AdelantoEmpleado[];
  total: number;
}

export interface PrimeCostData {
  totalVentas: number;
  facturasCMV: Factura[];
  totalCMV: number;
  /** Costo laboral "sueldos" = liquidaciones + gastos de empleado + especiales
   *  (aguinaldo/vacaciones). NO incluye cargas ni boletas (van aparte). */
  sueldos: number;
  especialesSueldos: number;
  cargasSociales: number;
  boletasSindicales: number;
  /** Costo laboral total = sueldos + cargas + boletas. */
  laborCost: number;
  /** Prime Cost = CMV + costo laboral total. */
  primeCost: number;
  sueldosDetalle: LiquidacionConEmpleado[];
  adelantosPorEmp: Record<string, AdelantoEmpleado[]>;
  sueldoMovsPorLiq: Map<string, number> | null;
  laborSinAsignar: number;
}

export async function cargarPrimeCost(
  user: Usuario,
  localActivo: number | null,
  mes: string,
): Promise<PrimeCostData> {
  const [yr, mo] = mes.split("-").map(Number) as [number, number];
  const lastDay = new Date(yr, mo, 0).getDate();
  const desde = mes + "-01", hasta = mes + "-" + String(lastDay).padStart(2, "0");
  const lid = localActivo ? parseInt(String(localActivo)) : null;

  let vq = db.from("ventas").select("fecha, monto, local_id").gte("fecha", desde).lte("fecha", hasta);
  vq = applyLocalScope(vq, user, lid);
  let fq = db.from("facturas")
    .select("id, fecha, total, cat, estado, local_id, bucket")
    .gte("fecha", desde).lte("fecha", hasta)
    .or("estado.neq.anulada,estado.is.null");
  fq = applyLocalScope(fq, user, lid);
  let gq = db.from("gastos").select("id, fecha, monto, categoria, tipo, local_id")
    .gte("fecha", desde).lte("fecha", hasta)
    .or("estado.neq.anulado,estado.is.null");
  gq = applyLocalScope(gq, user, lid);

  const [{ data: v }, { data: f }, { data: g }, { data: liqData }, { data: sueldoMovsData }, { data: especialesData }] =
    await Promise.all([
      vq,
      fq,
      gq,
      db.from("rrhh_liquidaciones")
        .select("*, rrhh_novedades(mes, anio, empleado_id, rrhh_empleados(nombre, apellido, puesto, local_id))")
        .in("estado", ["pendiente", "pagado"])
        .eq("anulado", false),
      db.from("movimientos")
        .select("importe, local_id, liquidacion_id")
        .eq("cat", "SUELDOS").eq("anulado", false).not("liquidacion_id", "is", null),
      db.from("movimientos")
        .select("importe, local_id")
        .eq("cat", "SUELDOS").eq("anulado", false).not("pago_especial_id_ref", "is", null)
        .gte("fecha", desde).lte("fecha", hasta),
    ]);

  const ventas = (v as Venta[]) || [];
  const facturas = (f as Factura[]) || [];
  const totalVentas = ventas.reduce((s, x) => s + (x.monto || 0), 0);

  // CMV = facturas con bucket NULL (legacy) o 'cat_compra'.
  const facturasCMV = [...facturas.filter(x => !x.bucket), ...facturas.filter(x => x.bucket === "cat_compra")];
  const totalCMV = facturasCMV.reduce((s, x) => s + (Number(x.total) || 0), 0);

  // Gastos: separar el costo laboral. Cargas/boletas quedan en `gastos` (línea
  // propia); el resto de gastos de empleado (adelantos, feriados) es "extraLabor".
  const allGastos = ((g as Gasto[]) || []).filter(x => x.categoria !== "SUELDOS");
  const esCargasOBoletas = (c?: string | null) => c === "CARGAS SOCIALES" || c === "BOLETAS SINDICALES";
  const gastosEmpleado = allGastos.filter(x => (x.tipo === "empleado" || x.tipo === "mano_obra") && !esCargasOBoletas(x.categoria));
  const gastos = allGastos.filter(x => (x.tipo !== "empleado" && x.tipo !== "mano_obra") || esCargasOBoletas(x.categoria));
  const cargasSociales = gastos.filter(x => x.categoria === "CARGAS SOCIALES").reduce((s, x) => s + (x.monto || 0), 0);
  const boletasSindicales = gastos.filter(x => x.categoria === "BOLETAS SINDICALES").reduce((s, x) => s + (x.monto || 0), 0);

  // Liquidaciones del mes/año.
  const liqRows = (((liqData as unknown) as LiquidacionConEmpleado[]) || [])
    .filter(l => l.rrhh_novedades?.mes === mo && l.rrhh_novedades?.anio === yr);
  const liqById = new Map(liqRows.map(l => [l.id!, l]));
  const sueldoMovs = ((sueldoMovsData as { importe: number; local_id: number; liquidacion_id: string }[]) || [])
    .filter(m => liqById.has(m.liquidacion_id));

  let sueldosDetalle: LiquidacionConEmpleado[];
  let sueldosLiq: number;
  let sueldoMovsPorLiq: Map<string, number> | null;
  if (lid) {
    const movsPorLiq = new Map<string, number>();
    for (const m of sueldoMovs) {
      if (m.local_id !== lid) continue;
      movsPorLiq.set(m.liquidacion_id, (movsPorLiq.get(m.liquidacion_id) || 0) + Math.abs(m.importe));
    }
    sueldosDetalle = liqRows.filter(l => {
      const emp = l.rrhh_novedades?.rrhh_empleados;
      return movsPorLiq.has(l.id!) || (emp ? emp.local_id === lid : false);
    });
    sueldosLiq = 0;
    for (const l of sueldosDetalle) {
      const fromMovs = movsPorLiq.get(l.id!);
      sueldosLiq += fromMovs != null ? fromMovs : (l.total_a_pagar || 0);
    }
    sueldoMovsPorLiq = movsPorLiq;
  } else {
    sueldosDetalle = liqRows;
    sueldosLiq = liqRows.reduce((s, l) => s + (l.total_a_pagar || 0), 0);
    sueldoMovsPorLiq = null;
  }

  const gastosEmpFilt = gastosEmpleado.filter(x => !lid || x.local_id === lid);
  const extraLabor = gastosEmpFilt.reduce((s, x) => s + (x.monto || 0), 0);
  const especialesSueldos = ((especialesData as { importe: number; local_id: number }[]) || [])
    .filter(m => !lid || m.local_id === lid)
    .reduce((s, m) => s + Math.abs(m.importe || 0), 0);
  const sueldos = sueldosLiq + extraLabor + especialesSueldos;

  // Atribuir cada gasto de empleado a su empleado (link vía rrhh_adelantos).
  const gastoIdsEmp = gastosEmpFilt.map(x => x.id).filter((x): x is string => !!x);
  const adelantosPorEmp: Record<string, AdelantoEmpleado[]> = {};
  let laborSinAsignar = 0;
  if (gastoIdsEmp.length) {
    const { data: adeData } = await db.from("rrhh_adelantos").select("gasto_id, empleado_id").in("gasto_id", gastoIdsEmp);
    const gastoToEmp = new Map<string, string>();
    for (const a of (adeData as { gasto_id: string | null; empleado_id: string | null }[]) || []) {
      if (a.gasto_id && a.empleado_id) gastoToEmp.set(a.gasto_id, String(a.empleado_id));
    }
    for (const gx of gastosEmpFilt) {
      const empId = gx.id ? gastoToEmp.get(gx.id) : undefined;
      if (empId) (adelantosPorEmp[empId] ||= []).push({ fecha: gx.fecha, monto: Number(gx.monto || 0), label: gx.categoria || "Adelanto" });
      else laborSinAsignar += Number(gx.monto || 0);
    }
    for (const arr of Object.values(adelantosPorEmp)) arr.sort((a, b) => a.fecha.localeCompare(b.fecha));
  } else {
    laborSinAsignar = extraLabor;
  }

  const laborCost = sueldos + cargasSociales + boletasSindicales;
  const primeCost = totalCMV + laborCost;

  return {
    totalVentas, facturasCMV, totalCMV,
    sueldos, especialesSueldos, cargasSociales, boletasSindicales,
    laborCost, primeCost,
    sueldosDetalle, adelantosPorEmp, sueldoMovsPorLiq, laborSinAsignar,
  };
}

/** Agrupa el costo laboral por empleado (para el desglose con drill-down).
 *  Espeja la lógica del bloque Sueldos del EERR. */
export function agruparLaborPorEmpleado(d: PrimeCostData): { filas: EmpleadoLaborRow[]; restoSinAsignar: number } {
  const grupos = d.sueldosDetalle.reduce<Record<string, { emp: EmpMin; total: number; liqs: LiquidacionConEmpleado[] }>>((acc, liq) => {
    const emp = liq.rrhh_novedades?.rrhh_empleados;
    if (!emp) return acc;
    const k = liq.rrhh_novedades!.empleado_id;
    if (!acc[k]) acc[k] = { emp, total: 0, liqs: [] };
    const fromMovs = d.sueldoMovsPorLiq?.get(liq.id!);
    acc[k]!.total += fromMovs != null ? fromMovs : (liq.total_a_pagar || 0);
    acc[k]!.liqs.push(liq);
    return acc;
  }, {});
  const conLiq = new Set(Object.keys(grupos));
  let huerfanos = 0;
  for (const [empId, items] of Object.entries(d.adelantosPorEmp)) {
    if (!conLiq.has(empId)) huerfanos += items.reduce((s, i) => s + i.monto, 0);
  }
  const restoSinAsignar = d.laborSinAsignar + huerfanos;
  const filas = Object.entries(grupos).map(([empId, gg]) => {
    const ade = d.adelantosPorEmp[empId] || [];
    return { emp: gg.emp, liqs: gg.liqs, ade, total: gg.total + ade.reduce((s, i) => s + i.monto, 0) };
  }).sort((a, b) => b.total - a.total);
  return { filas, restoSinAsignar };
}
