/* eslint-disable react-hooks/static-components --
 * ERow y ESection son componentes inner (definidos dentro de EERR) que
 * capturan `pct` por closure. `pct` depende de `totalVentas` (state-derivado),
 * por lo que mover los componentes afuera requiere pasarlo como prop —
 * refactor que sale del scope del PR8 ("no mover funciones").
 *
 * Riesgo conocido: cada render crea referencias nuevas → React resetea state
 * interno de los componentes hijos. ERow/ESection son puramente
 * presentacionales (no tienen state), así que el impacto es solo en perf
 * (re-mount innecesario), no en corrección.
 *
 * TODO(eerr-refactor): mover ERow/ESection a archivos separados con pct
 * y totalVentas como props. Hacer en PR aparte cuando se toque la lógica.
 */
import { useState, useEffect, lazy, Suspense } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope } from "../lib/auth";
import { useCategorias } from "../lib/useCategorias";
import { useMediosCobro } from "../lib/useMediosCobro";
import { InfoTooltip } from "../components/ui";
import { toISO, fmt_$ } from "@pase/shared/utils";
import { today } from "../lib/utils";
import EERRSimulador from "./EERRSimulador";
import type { LineasEERR } from "../lib/eerrSimulador";
import { estaCerrado, cerrarPeriodo, reabrirPeriodo } from "../lib/periodos";
import { listarSocios } from "../lib/utilidades";
import { translateRpcError } from "../lib/errors";
import EERRDetalleModal from "./EERRDetalleModal";
import { buildSueldoBreakdown, ordenarPorCategoria } from "./eerrDetalle";
import type { DetalleState, DetalleDescriptor, AdelantoEmpleado } from "./eerrDetalle";

// Cómo encontrar los movimientos que componen cada sección del desglose.
// Debe quedar en sync con los porCat* / totales de abajo (misma lógica de
// tipo de gasto + bucket de factura).
const DETALLE_SECCIONES: Record<string, DetalleDescriptor> = {
  cmv:        { gastoTipo: null,          facturaBucket: null,               cmv: true },
  fijo:       { gastoTipo: "fijo",        facturaBucket: "gasto_fijo" },
  variable:   { gastoTipo: "variable",    facturaBucket: "gasto_variable" },
  publicidad: { gastoTipo: "publicidad",  facturaBucket: "gasto_publicidad" },
  comision:   { gastoTipo: "comision",    facturaBucket: "gasto_comision" },
  impuesto:   { gastoTipo: "impuesto",    facturaBucket: "gasto_impuesto" },
  otros:      { gastoTipo: null,          facturaBucket: null,               otros: true },
  retiro:     { gastoTipo: "retiro_socio", facturaBucket: null },
};

// Recharts pesa ~250KB. Se code-splittea aparte para que el chunk inicial
// de /reportes no lo arrastre. Si el usuario ve EERR sin meses comparados
// y sin categorías CMV (caso común mid-month), recharts NUNCA se descarga.
const EvolucionChart = lazy(() => import("./EERRCharts").then(m => ({ default: m.EvolucionChart })));
const CategoriaCMVChart = lazy(() => import("./EERRCharts").then(m => ({ default: m.CategoriaCMVChart })));
import type { Usuario } from "../types/auth";
import type { Venta, Factura, Gasto } from "../types/finanzas";
import type { LiquidacionConEmpleado } from "../types/rrhh";

interface EERRProps {
  user: Usuario;
  localActivo: number | null;
}

// Resumen totalizado de un mes — base para comparativas y gráfico de
// evolución. La pantalla calcula esto in-line para el mes principal y via
// cargarMesResumen() para los meses extra.
interface MesResumen {
  mes: string; // "YYYY-MM"
  ventas: number;
  cmv: number;
  gastosFijos: number;
  gastosVar: number;
  publicidad: number;
  comisiones: number;
  impuestos: number;
  otrosGastos: number;
  sueldos: number;
  cargasSociales: number;
  utilBruta: number;
  utilNeta: number;
}

interface LiquidacionPendienteRow {
  total_a_pagar: number;
  rrhh_novedades: { mes: number; anio: number; rrhh_empleados: { local_id: number | null } | null } | null;
}

const fmtMesLabel = (mes: string): string => {
  const [yr, mo] = mes.split("-").map(Number) as [number, number];
  const nombres = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  return `${nombres[mo-1]} ${String(yr).slice(2)}`;
};

export default function EERR({ user, localActivo }: EERRProps) {
  const { CATEGORIAS_COMPRA, GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD, COMISIONES_CATS, GASTOS_IMPUESTOS, RETIROS_SOCIOS } = useCategorias();
  const { mediosDisponibles } = useMediosCobro();
  const [ventas,setVentas]=useState<Venta[]>([]);
  const [facturas,setFacturas]=useState<Factura[]>([]);
  const [gastos,setGastos]=useState<Gasto[]>([]);
  const [sueldos,setSueldos]=useState(0);
  const [especialesSueldos,setEspecialesSueldos]=useState(0);
  const [sueldosDetalle,setSueldosDetalle]=useState<LiquidacionConEmpleado[]>([]);
  const [sueldoMovsPorLiq,setSueldoMovsPorLiq]=useState<Map<string,number>|null>(null);
  // Adelantos (y otros gastos de empleado) atribuidos a cada empleado, para
  // mostrar el sueldo completo por persona en el desglose de Sueldos.
  const [adelantosPorEmp,setAdelantosPorEmp]=useState<Record<string,AdelantoEmpleado[]>>({});
  const [laborSinAsignar,setLaborSinAsignar]=useState(0);
  const [sueldosExpanded,setSueldosExpanded]=useState(false);
  const [detalle,setDetalle]=useState<DetalleState|null>(null);
  // Devuelve el handler de click para las filas de una sección del desglose.
  const abrirCat=(descriptor: DetalleDescriptor)=>(categoria: string)=>
    setDetalle({tipo:"cat",titulo:categoria,descriptor,categoria});
  const [mes,setMes]=useState(toISO(today).slice(0,7));
  const [loading,setLoading]=useState(true);
  const [simulando,setSimulando]=useState(false);
  const [mesCerrado,setMesCerrado]=useState(false);
  const [cerrandoMes,setCerrandoMes]=useState(false);
  const [exportando,setExportando]=useState(false);
  const [menuExport,setMenuExport]=useState(false);
  const esDuenoAdmin = user.rol === "dueno" || user.rol === "admin";
  // Meses adicionales para comparar (máximo 2). Si están vacíos, la pantalla
  // funciona como antes (solo mes principal). Cuando se agregan, el Resumen
  // P&L pasa a columnas comparativas y aparece el gráfico de evolución.
  const [mesesComp,setMesesComp]=useState<string[]>([]);
  const [dataComp,setDataComp]=useState<Record<string, MesResumen>>({});
  const [loadingComp,setLoadingComp]=useState(false);

  // Carga un resumen totalizado de un mes (sin detalles por categoría).
  // Para meses adicionales en el comparativo. La lógica es paralela al cálculo
  // del mes principal pero retorna un objeto en vez de setear state.
  const cargarMesResumen = async (mesArg: string): Promise<MesResumen> => {
    const [yr, mo] = mesArg.split("-").map(Number) as [number, number];
    const lastDay = new Date(yr, mo, 0).getDate();
    const desde = mesArg + "-01", hasta = mesArg + "-" + String(lastDay).padStart(2, "0");
    const lid = localActivo ? parseInt(String(localActivo)) : null;
    let vq = db.from("ventas").select("monto, local_id").gte("fecha", desde).lte("fecha", hasta);
    vq = applyLocalScope(vq, user, lid);
    let fq = db.from("facturas").select("total, bucket, local_id").gte("fecha", desde).lte("fecha", hasta).or("estado.neq.anulada,estado.is.null");
    fq = applyLocalScope(fq, user, lid);
    let gq = db.from("gastos").select("monto, tipo, categoria, local_id").gte("fecha", desde).lte("fecha", hasta).or("estado.neq.anulado,estado.is.null");
    gq = applyLocalScope(gq, user, lid);
    const [{ data: v }, { data: f }, { data: g0 }, { data: liq }, { data: sMov }] = await Promise.all([
      vq, fq, gq,
      db.from("rrhh_liquidaciones")
        .select("id, total_a_pagar, rrhh_novedades(mes, anio, rrhh_empleados(local_id))")
        .in("estado", ["pendiente", "pagado"]).eq("anulado", false),
      db.from("movimientos")
        .select("importe, local_id, liquidacion_id")
        .eq("cat", "SUELDOS").eq("anulado", false)
        .not("liquidacion_id", "is", null),
    ]);
    const ventasArr = (v as Venta[]) || [];
    const facturasArr = (f as Factura[]) || [];
    const allGastos = ((g0 as Gasto[]) || []).filter(x => x.categoria !== "SUELDOS");
    // Costo laboral = sueldos (RRHH) + gastos tipo empleado + mano_obra (suelta).
    // Cargas/Boletas son mano_obra pero van en su LÍNEA propia: se sacan del sum
    // de sueldos (gastosEmp) y quedan en gastosArr para contarlas por categoría.
    const esCargasOBoletas = (c?: string | null) => c === "CARGAS SOCIALES" || c === "BOLETAS SINDICALES";
    const gastosEmp = allGastos.filter(x => (x.tipo === "empleado" || x.tipo === "mano_obra") && !esCargasOBoletas(x.categoria));
    const gastosArr = allGastos.filter(x => (x.tipo !== "empleado" && x.tipo !== "mano_obra") || esCargasOBoletas(x.categoria));
    const liqRows = (((liq as unknown) as (LiquidacionPendienteRow & {id:string})[]) || [])
      .filter(l => l.rrhh_novedades?.mes === mo && l.rrhh_novedades?.anio === yr);
    const liqIdSet = new Set(liqRows.map(l => l.id));
    const sueldoMovsComp = ((sMov as {importe:number,local_id:number,liquidacion_id:string}[]) || [])
      .filter(m => liqIdSet.has(m.liquidacion_id));
    const ventas = ventasArr.reduce((s, x) => s + Number(x.monto), 0);
    const facsCMV = facturasArr.filter(x => !x.bucket || x.bucket === "cat_compra");
    const facsBucket = (b: string) => facturasArr.filter(x => x.bucket === b);
    const sumF = (arr: Factura[]) => arr.reduce((s, x) => s + Number(x.total), 0);
    const cmv = sumF(facsCMV);
    // Costo laboral: cargas sociales + boletas sindicales juntas en la
    // comparativa (línea separada solo en el detalle de un mes).
    const cargasSociales = gastosArr.filter(x => esCargasOBoletas(x.categoria)).reduce((s, x) => s + Number(x.monto), 0);
    const gastosFijos = gastosArr.filter(x => x.tipo === "fijo" && x.categoria !== "CARGAS SOCIALES" && x.categoria !== "BOLETAS SINDICALES").reduce((s, x) => s + Number(x.monto), 0) + sumF(facsBucket("gasto_fijo"));
    const gastosVar = gastosArr.filter(x => x.tipo === "variable").reduce((s, x) => s + Number(x.monto), 0) + sumF(facsBucket("gasto_variable"));
    const publicidad = gastosArr.filter(x => x.tipo === "publicidad").reduce((s, x) => s + Number(x.monto), 0) + sumF(facsBucket("gasto_publicidad"));
    const comisiones = gastosArr.filter(x => x.tipo === "comision").reduce((s, x) => s + Number(x.monto), 0) + sumF(facsBucket("gasto_comision"));
    const impuestos = gastosArr.filter(x => x.tipo === "impuesto").reduce((s, x) => s + Number(x.monto), 0) + sumF(facsBucket("gasto_impuesto"));
    const otrosGastos = gastosArr.filter(x => !["fijo","variable","publicidad","comision","impuesto","retiro_socio","empleado","mano_obra"].includes(x.tipo)).reduce((s, x) => s + Number(x.monto), 0);
    let sueldos: number;
    const gastosEmpFilt = gastosEmp.filter(x => !lid || x.local_id === lid);
    if (lid) {
      const movsPorLiq = new Map<string,number>();
      for (const m of sueldoMovsComp) {
        if (m.local_id !== lid) continue;
        movsPorLiq.set(m.liquidacion_id, (movsPorLiq.get(m.liquidacion_id) || 0) + Math.abs(m.importe));
      }
      const liqFilt = liqRows.filter(l => movsPorLiq.has(l.id) || (l.rrhh_novedades?.rrhh_empleados?.local_id === lid));
      sueldos = 0;
      for (const l of liqFilt) {
        const fromMovs = movsPorLiq.get(l.id);
        sueldos += fromMovs != null ? fromMovs : Number(l.total_a_pagar);
      }
    } else {
      sueldos = liqRows.reduce((s, l) => s + Number(l.total_a_pagar), 0);
    }
    sueldos += gastosEmpFilt.reduce((s, x) => s + Number(x.monto), 0);
    const utilBruta = ventas - cmv;
    const utilNeta = utilBruta - gastosFijos - gastosVar - sueldos - cargasSociales - publicidad - comisiones - impuestos - otrosGastos;
    return { mes: mesArg, ventas, cmv, gastosFijos, gastosVar, publicidad, comisiones, impuestos, otrosGastos, sueldos, cargasSociales, utilBruta, utilNeta };
  };

  // Cargar los resúmenes de los meses comparados. Se dispara cuando cambia
  // mesesComp o cambia localActivo (los datos cacheados se invalidan porque
  // pueden ser de otro local).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- el setState sincrónico es intencional: limpiar dataComp cuando el usuario quita todos los meses. No hay ciclo: si mesesComp ya era [], el effect no se re-dispara.
    if (mesesComp.length === 0) { setDataComp({}); return; }
    let cancelled = false;
    setLoadingComp(true);
    Promise.all(mesesComp.map(m => cargarMesResumen(m))).then(results => {
      if (cancelled) return;
      const next: Record<string, MesResumen> = {};
      for (const r of results) next[r.mes] = r;
      setDataComp(next);
      setLoadingComp(false);
    });
    return () => { cancelled = true; };
  // user no cambia. cargarMesResumen tampoco — captura state via closure.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesesComp, localActivo]);

  useEffect(()=>{
    const load=async()=>{
      setLoading(true);
      const [yr,mo]=mes.split("-").map(Number) as [number, number];
      const lastDay=new Date(yr,mo,0).getDate();
      const desde=mes+"-01", hasta=mes+"-"+String(lastDay).padStart(2,"0");
      const lid=localActivo?parseInt(String(localActivo)):null;
      // Optimización egress 2026-05-17: proyectar solo lo que EERR realmente usa.
      // Antes SELECT * traía JSON + campos auditoría innecesarios para reporte.
      let vq = db.from("ventas").select("fecha, monto, medio, local_id").gte("fecha",desde).lte("fecha",hasta);
      vq = applyLocalScope(vq, user, lid);
      let fq = db.from("facturas").select("id, fecha, total, neto, iva21, iva105, iibb, cat, estado, local_id, tipo, bucket").gte("fecha",desde).lte("fecha",hasta).or("estado.neq.anulada,estado.is.null");
      fq = applyLocalScope(fq, user, lid);
      let gq = db.from("gastos").select("id, fecha, monto, categoria, tipo, local_id").gte("fecha",desde).lte("fecha",hasta).or("estado.neq.anulado,estado.is.null");
      gq = applyLocalScope(gq, user, lid);
      const [{data:v},{data:f},{data:g},{data:liqData},{data:sueldoMovsData},{data:especialesData}]=await Promise.all([
        vq,
        fq,
        gq,
        db.from("rrhh_liquidaciones")
          .select("*, rrhh_novedades(mes, anio, empleado_id, rrhh_empleados(nombre, apellido, puesto, local_id))")
          .in("estado", ["pendiente", "pagado"])
          .eq("anulado", false),
        db.from("movimientos")
          .select("importe, local_id, liquidacion_id")
          .eq("cat", "SUELDOS")
          .eq("anulado", false)
          .not("liquidacion_id", "is", null),
        // Aguinaldos y vacaciones (pagar_aguinaldo/pagar_vacaciones) → movimiento
        // cat='SUELDOS' con pago_especial_id_ref (liquidacion_id NULL). El EERR los
        // omitía; se cuentan como sueldo del mes en que se pagan (Lucas 12-jul).
        db.from("movimientos")
          .select("importe, local_id")
          .eq("cat", "SUELDOS")
          .eq("anulado", false)
          .not("pago_especial_id_ref", "is", null)
          .gte("fecha", desde).lte("fecha", hasta),
      ]);
      setVentas((v as Venta[]) || []);
      setFacturas((f as Factura[]) || []);
      const allGastos = ((g as Gasto[]) || []).filter((x) => x.categoria !== "SUELDOS");
      // Cargas/Boletas (mano_obra) van en su línea propia: fuera del sum de
      // sueldos, pero quedan en `gastos` para contarlas por categoría.
      const esCargasOBoletas = (c?: string | null) => c === "CARGAS SOCIALES" || c === "BOLETAS SINDICALES";
      const gastosEmpleado = allGastos.filter(x => (x.tipo === "empleado" || x.tipo === "mano_obra") && !esCargasOBoletas(x.categoria));
      setGastos(allGastos.filter(x => (x.tipo !== "empleado" && x.tipo !== "mano_obra") || esCargasOBoletas(x.categoria)));
      const liqRows = (((liqData as unknown) as LiquidacionConEmpleado[]) || [])
        .filter(l => l.rrhh_novedades?.mes === mo && l.rrhh_novedades?.anio === yr);
      const liqById = new Map(liqRows.map(l => [l.id!, l]));
      const sueldoMovs = ((sueldoMovsData as {importe:number,local_id:number,liquidacion_id:string}[]) || [])
        .filter(m => liqById.has(m.liquidacion_id));

      let liqFiltradas: LiquidacionConEmpleado[];
      let sueldosTotal: number;
      if (lid) {
        const movsPorLiq = new Map<string,number>();
        for (const m of sueldoMovs) {
          if (m.local_id !== lid) continue;
          movsPorLiq.set(m.liquidacion_id, (movsPorLiq.get(m.liquidacion_id) || 0) + Math.abs(m.importe));
        }
        liqFiltradas = liqRows.filter(l => {
          const emp = l.rrhh_novedades?.rrhh_empleados;
          return movsPorLiq.has(l.id!) || (emp ? emp.local_id === lid : false);
        });
        sueldosTotal = 0;
        for (const l of liqFiltradas) {
          const fromMovs = movsPorLiq.get(l.id!);
          if (fromMovs != null) {
            sueldosTotal += fromMovs;
          } else {
            sueldosTotal += l.total_a_pagar || 0;
          }
        }
      } else {
        liqFiltradas = liqRows;
        sueldosTotal = liqRows.reduce((s, l) => s + (l.total_a_pagar || 0), 0);
      }
      setSueldosDetalle(liqFiltradas);
      setSueldoMovsPorLiq(lid ? (() => {
        const m = new Map<string,number>();
        for (const mv of sueldoMovs) {
          if (mv.local_id !== lid) continue;
          m.set(mv.liquidacion_id, (m.get(mv.liquidacion_id) || 0) + Math.abs(mv.importe));
        }
        return m;
      })() : null);
      const gastosEmpFilt = gastosEmpleado.filter(x => !lid || x.local_id === lid);
      const extraLabor = gastosEmpFilt.reduce((s, x) => s + (x.monto || 0), 0);
      const especialesTotal = ((especialesData as {importe:number, local_id:number}[]) || [])
        .filter(m => !lid || m.local_id === lid)
        .reduce((s, m) => s + Math.abs(m.importe || 0), 0);
      setEspecialesSueldos(especialesTotal);
      setSueldos(sueldosTotal + extraLabor + especialesTotal);

      // Atribuir cada gasto de empleado (adelanto/feriado/etc.) a su empleado,
      // para que el desglose de Sueldos muestre el sueldo completo por persona.
      // El link gasto→empleado vive en rrhh_adelantos. Lo que no tenga link
      // (mano de obra sin empleado) queda en `laborSinAsignar` (fila aparte).
      const gastoIdsEmp = gastosEmpFilt.map(x => x.id).filter((x): x is string => !!x);
      const adelMap: Record<string, AdelantoEmpleado[]> = {};
      let sinAsignar = 0;
      if (gastoIdsEmp.length) {
        const { data: adeData } = await db.from("rrhh_adelantos")
          .select("gasto_id, empleado_id").in("gasto_id", gastoIdsEmp);
        const gastoToEmp = new Map<string, string>();
        for (const a of (adeData as { gasto_id: string | null; empleado_id: string | null }[]) || []) {
          if (a.gasto_id && a.empleado_id) gastoToEmp.set(a.gasto_id, String(a.empleado_id));
        }
        for (const g of gastosEmpFilt) {
          const empId = g.id ? gastoToEmp.get(g.id) : undefined;
          if (empId) (adelMap[empId] ||= []).push({ fecha: g.fecha, monto: Number(g.monto || 0), label: g.categoria || "Adelanto" });
          else sinAsignar += Number(g.monto || 0);
        }
        for (const arr of Object.values(adelMap)) arr.sort((a, b) => a.fecha.localeCompare(b.fecha));
      } else {
        sinAsignar = extraLabor;
      }
      setAdelantosPorEmp(adelMap);
      setLaborSinAsignar(sinAsignar);
      setLoading(false);
    };
    load();
  // user no cambia durante el lifecycle (App desmonta en logout).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[mes,localActivo]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (localActivo == null) { setMesCerrado(false); return; }
    let cancel = false;
    estaCerrado(localActivo, mes).then(({ data }) => { if (!cancel) setMesCerrado(!!data); });
    return () => { cancel = true; };
  },[mes,localActivo]);

  const totalVentas=ventas.reduce((s, v)=>s+(v.monto||0),0);
  // Clasificación por bucket: facturas con bucket NULL (legacy) o
  // bucket='cat_compra' van al CMV. Facturas con bucket='gasto_*' suman al
  // bucket de gastos correspondiente, junto con la tabla `gastos`.
  // Esto permite cargar servicios (AySA, Edenor, MP, Rappi) por Compras sin
  // inflar el CMV. Migration 202605130000 introdujo facturas.bucket.
  const facturasBucket=(b: string|null)=>facturas.filter(f=>(f.bucket||null)===b);
  const facturasCMV=[...facturas.filter(f=>!f.bucket), ...facturasBucket("cat_compra")];
  const sumarMonto=<T extends {total?:number,monto?:number}>(rows:T[],key:"total"|"monto"="total")=>rows.reduce((s,x)=>s+(Number(x[key])||0),0);
  const totalCMV=sumarMonto(facturasCMV,"total");
  const totalCargasSociales=gastos.filter((g)=>g.categoria==="CARGAS SOCIALES").reduce((s, g)=>s+(g.monto||0),0);
  // Boletas sindicales (cuota sindical + obra social): costo laboral, línea
  // propia (Lucas 16-jun). Se excluye de Gastos Fijos para no contar doble.
  const totalBoletasSindicales=gastos.filter((g)=>g.categoria==="BOLETAS SINDICALES").reduce((s, g)=>s+(g.monto||0),0);
  const totalGastosFijos=gastos.filter((g)=>g.tipo==="fijo"&&g.categoria!=="CARGAS SOCIALES"&&g.categoria!=="BOLETAS SINDICALES").reduce((s, g)=>s+(g.monto||0),0)+sumarMonto(facturasBucket("gasto_fijo"),"total");
  const totalGastosVar=gastos.filter((g)=>g.tipo==="variable").reduce((s, g)=>s+(g.monto||0),0)+sumarMonto(facturasBucket("gasto_variable"),"total");
  const totalPublicidad=gastos.filter((g)=>g.tipo==="publicidad").reduce((s, g)=>s+(g.monto||0),0)+sumarMonto(facturasBucket("gasto_publicidad"),"total");
  const totalComisiones=gastos.filter((g)=>g.tipo==="comision").reduce((s, g)=>s+(g.monto||0),0)+sumarMonto(facturasBucket("gasto_comision"),"total");
  const totalImpuestos=gastos.filter((g)=>g.tipo==="impuesto").reduce((s, g)=>s+(g.monto||0),0)+sumarMonto(facturasBucket("gasto_impuesto"),"total");
  const totalOtrosGastos=gastos.filter((g)=>!["fijo","variable","publicidad","comision","impuesto","retiro_socio","empleado","mano_obra"].includes(g.tipo)).reduce((s, g)=>s+(g.monto||0),0);
  // Retiros de socios: distribución de utilidades / compras personales pagadas
  // por el negocio. NO suma a gastos operativos; se muestra DESPUÉS de Util.
  // Neta. Incluye TODO el tipo retiro_socio (Retiro socio, COMPRA ONLINE, etc.)
  // EXCEPTO "RETIRO EFECTIVO", que es un movimiento de caja ya contado y el EERR
  // ignora a propósito (Lucas 22-jun: COMPRA ONLINE SÍ es retiro de socios).
  const ES_RETIRO = (g: { tipo: string; categoria: string | null }) =>
    g.tipo === "retiro_socio" && g.categoria !== "RETIRO EFECTIVO";
  const totalRetiros=gastos.filter(ES_RETIRO).reduce((s, g)=>s+(g.monto||0),0);
  const totalGastos=totalGastosFijos+totalGastosVar;
  const utilBruta=totalVentas-totalCMV;
  const utilNeta=utilBruta-totalGastos-sueldos-totalCargasSociales-totalBoletasSindicales-totalPublicidad-totalComisiones-totalImpuestos-totalOtrosGastos;
  // Prime Cost = Compras de mercadería + Costo laboral (sueldos + cargas +
  // boletas sindicales). KPI #1 de gastronomía: lo que el dueño controla día a
  // día. Benchmark típico ≤60% de las ventas (verde); 60-65% amarillo; >65% rojo.
  const primeCost=totalCMV+sueldos+totalCargasSociales+totalBoletasSindicales;
  const primePct=totalVentas>0?(primeCost/totalVentas)*100:0;
  // utilNetaPostRetiros: lo que queda al socio después de retirar lo que
  // efectivamente retiró. Si retiró todo, es ~0; si no retiró, == utilNeta.
  const utilNetaPostRetiros=utilNeta-totalRetiros;
  const pct=(n: number)=>totalVentas>0?((n/totalVentas)*100).toFixed(1)+"%":"0%";

  // Itera sobre los medios que tienen ventas en el período (no sobre un
  // array fijo). Ventas legacy con un medio que ya no existe en el catálogo
  // siguen apareciendo con su nombre raw — no se las pierde del histórico.
  // El catálogo se usa solo para ordenar (refleja el "orden" de Configuración)
  // y para preferir el nombre canónico si hay match.
  const catalogoEERR=mediosDisponibles(localActivo?Number(localActivo):null);
  const ordenCanon=new Map(catalogoEERR.map(m=>[m.nombre,m.orden]));
  const ventasPorMedio:Record<string,number>={};
  for(const v of ventas){const k=v.medio||"—";ventasPorMedio[k]=(ventasPorMedio[k]||0)+(v.monto||0);}
  const porMedio=Object.entries(ventasPorMedio)
    .map(([m,t])=>({m,t}))
    .filter(x=>x.t>0)
    .sort((a,b)=>{
      const oa=ordenCanon.get(a.m), ob=ordenCanon.get(b.m);
      // Catálogo primero (orden ascendente); legacy al final por monto desc.
      if(oa!==undefined && ob!==undefined) return oa-ob;
      if(oa!==undefined) return -1;
      if(ob!==undefined) return 1;
      return b.t-a.t;
    });
  // Detalle por categoría: se arma desde los DATOS reales (no recorriendo el
  // catálogo) para que el detalle SIEMPRE cuadre con el total del grupo. El
  // catálogo solo ordena (catálogo primero en su orden, huérfanas después por
  // monto). Bug 21-jun: antes recorría el catálogo y se comía los gastos cuya
  // categoría no estaba listada (REPARTIDORES, Sueldo evento, PERSONAL…) — sumaban
  // al total del grupo pero no aparecían como línea. Las facturas con
  // bucket=cat_compra (o legacy null) van al CMV.
  const itemsGastoFact = (gastoTipo: string, factBucket: string, excluir: string[] = []) => [
    ...gastos.filter(g => g.tipo === gastoTipo && !excluir.includes(g.categoria || ""))
      .map(g => ({ cat: g.categoria, monto: Number(g.monto || 0) })),
    ...facturasBucket(factBucket).map(f => ({ cat: f.cat, monto: Number(f.total || 0) })),
  ];
  const porCatCMV=ordenarPorCategoria(facturasCMV.map(f=>({cat:f.cat,monto:Number(f.total||0)})), CATEGORIAS_COMPRA);
  const porCatFijos=ordenarPorCategoria(itemsGastoFact("fijo","gasto_fijo",["CARGAS SOCIALES","BOLETAS SINDICALES"]), GASTOS_FIJOS.filter(c=>c!=="CARGAS SOCIALES"&&c!=="BOLETAS SINDICALES"));
  const porCatVar=ordenarPorCategoria(itemsGastoFact("variable","gasto_variable"), GASTOS_VARIABLES);
  const porCatPub=ordenarPorCategoria(itemsGastoFact("publicidad","gasto_publicidad"), GASTOS_PUBLICIDAD);
  const porCatCom=ordenarPorCategoria(itemsGastoFact("comision","gasto_comision"), COMISIONES_CATS);
  const porCatImp=ordenarPorCategoria(itemsGastoFact("impuesto","gasto_impuesto"), GASTOS_IMPUESTOS);
  const porCatRet=ordenarPorCategoria(gastos.filter(ES_RETIRO).map(g=>({cat:g.categoria,monto:Number(g.monto||0)})), RETIROS_SOCIOS);
  const otrosGastosArr=gastos.filter(g=>!["fijo","variable","publicidad","comision","impuesto","retiro_socio","empleado","mano_obra"].includes(g.tipo));
  const porCatOtros=Object.entries(otrosGastosArr.reduce<Record<string,number>>((acc,g)=>{const k=g.categoria||g.tipo;acc[k]=(acc[k]||0)+(g.monto||0);return acc},{})).map(([c,t])=>({c,t})).filter(x=>x.t>0).sort((a,b)=>b.t-a.t);

  const ERow=({label,valor,color,big}: {label: string, valor: number, color: string, big?: boolean})=>(
    <div className="eerr-row-summary" style={big?{borderTop: "0.5px solid var(--pase-border)",marginTop:2}:{}}>
      <span style={{fontSize:12,fontWeight:big?600:400,color:"var(--pase-text)"}}>{label}</span>
      <div style={{textAlign:"right"}}>
        <span style={{fontFamily:"'Inter',sans-serif",fontSize:13,fontWeight:500,color,fontVariantNumeric:"tabular-nums"}}>{fmt_$(valor)}</span>
        <span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(Math.abs(valor))}</span>
      </div>
    </div>
  );

  // ESection se define afuera — pct se pasa como prop

  // Resumen del mes principal en el mismo formato que dataComp — para
  // consumir por el gráfico de evolución y la tabla comparativa.
  const resumenPrincipal: MesResumen = {
    mes,
    ventas: totalVentas,
    cmv: totalCMV,
    gastosFijos: totalGastosFijos,
    gastosVar: totalGastosVar,
    publicidad: totalPublicidad,
    comisiones: totalComisiones,
    impuestos: totalImpuestos,
    otrosGastos: totalOtrosGastos,
    sueldos,
    // En la comparativa/trend, cargas + boletas sindicales van juntas como
    // costo laboral (línea separada solo en el detalle de un mes).
    cargasSociales: totalCargasSociales + totalBoletasSindicales,
    utilBruta,
    utilNeta,
  };

  // Base para el simulador de escenarios (mismas cifras que el EERR; cargas
  // sociales incluye boletas sindicales, igual que resumenPrincipal).
  const baseSimulador: LineasEERR = {
    ventas: totalVentas,
    cmv: totalCMV,
    gastosFijos: totalGastosFijos,
    gastosVar: totalGastosVar,
    sueldos,
    cargasSociales: totalCargasSociales + totalBoletasSindicales,
    publicidad: totalPublicidad,
    comisiones: totalComisiones,
    impuestos: totalImpuestos,
    otrosGastos: totalOtrosGastos,
  };

  // Lista ordenada cronológicamente (para gráfico y columnas). Mes principal
  // se mezcla con los comparados; el orden por mes da una serie temporal.
  const mesesOrdenados = [resumenPrincipal, ...mesesComp.map(m => dataComp[m]).filter((x): x is MesResumen => !!x)]
    .sort((a, b) => a.mes.localeCompare(b.mes));

  const agregarMesComp = () => {
    if (mesesComp.length >= 2) return;
    // Default: un mes anterior al más viejo seleccionado (o al principal).
    const ref = mesesComp.length > 0
      ? [...mesesComp].sort()[0]
      : mes;
    if (!ref) return;
    const [yr, mo] = ref.split("-").map(Number) as [number, number];
    const prev = mo === 1 ? `${yr - 1}-12` : `${yr}-${String(mo - 1).padStart(2, "0")}`;
    if (mesesComp.includes(prev) || prev === mes) return;
    setMesesComp([...mesesComp, prev]);
  };

  const cambiarMesComp = (idx: number, nuevoMes: string) => {
    if (nuevoMes === mes || mesesComp.includes(nuevoMes)) return;
    setMesesComp(mesesComp.map((m, i) => i === idx ? nuevoMes : m));
  };

  const quitarMesComp = (m: string) => {
    setMesesComp(mesesComp.filter(x => x !== m));
  };

  // Datos para el line chart de evolución. Una fila por mes con todas las
  // métricas. Solo se renderiza cuando hay >=1 mes comparado (es decir, >=2
  // meses en mesesOrdenados).
  const evolucionData = mesesOrdenados.map(r => ({
    mes: fmtMesLabel(r.mes),
    Ventas: Math.round(r.ventas),
    Compras: Math.round(r.cmv),
    "Sueldos + CS": Math.round(r.sueldos + r.cargasSociales),
    "Util. Neta": Math.round(r.utilNeta),
  }));

  // ── Export (botón "Exportar") ──────────────────────────────────────────────
  // "Canje" no es facturación real (trueque): se saca de las formas de pago y
  // se resta de las ventas → como bajan las ventas, baja también utilidad bruta
  // y neta (el reporte queda consistente: ventas − costos = utilidad).
  const canjeMonto = porMedio.filter(x => /canje/i.test(x.m)).reduce((s, x) => s + x.t, 0);
  const ventasReales = totalVentas - canjeMonto;
  const utilBrutaReal = utilBruta - canjeMonto;
  const utilNetaReal = utilNeta - canjeMonto;

  const nombreLocalExport = async (): Promise<string> => {
    if (localActivo == null) return "Todos los locales";
    const { data: loc } = await db.from("locales").select("nombre").eq("id", localActivo).maybeSingle();
    return (loc?.nombre as string | undefined) || "Local";
  };

  // Resumen P&L de 1 hoja en PDF (estética PASE).
  const exportarResumenUnaHoja = async () => {
    setMenuExport(false); setExportando(true);
    try {
      const localNombre = await nombreLocalExport();
      const { exportEERRPdf } = await import("../lib/exportEERRPdf");
      await exportEERRPdf({
        localNombre, mes, emitido: new Date().toLocaleDateString("es-AR"),
        ventas: ventasReales, cmv: totalCMV, utilBruta: utilBrutaReal, gastosFijosVar: totalGastos,
        sueldos, cargas: totalCargasSociales, boletas: totalBoletasSindicales,
        publicidad: totalPublicidad, comisiones: totalComisiones, impuestos: totalImpuestos,
        otros: totalOtrosGastos, utilNeta: utilNetaReal,
      });
    } catch (e) {
      alert("No se pudo generar el PDF: " + (e instanceof Error ? e.message : String(e)));
    } finally { setExportando(false); }
  };

  // Presentación de cierre (6 slides) en PDF o PowerPoint.
  const prevMesDe = (m: string): string => {
    const [yr, mo] = m.split("-").map(Number);
    const d = new Date((yr ?? 2026), (mo ?? 1) - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const exportarCierre = async (formato: "pdf" | "pptx") => {
    setMenuExport(false); setExportando(true);
    try {
      const localNombre = await nombreLocalExport();
      const pmes = prevMesDe(mes);
      const prevRes = await cargarMesResumen(pmes).catch(() => null);
      let socios: { nombre: string; porcentaje: number }[] = [];
      if (localActivo != null) {
        const { data: ss } = await listarSocios(localActivo);
        socios = (ss || []).filter(s => s.activo).map(s => ({ nombre: s.nombre, porcentaje: Number(s.porcentaje) }));
      }
      // Personal por empleado: misma lógica que el desglose de Sueldos en
      // pantalla (liquidación + adelantos atribuidos + mano de obra sin asignar).
      // Suma = total de Sueldos. Le agregamos Cargas y Boletas para que la slide
      // refleje el costo laboral completo.
      const gruposEmp = sueldosDetalle.reduce<Record<string, { emp: { apellido: string; nombre: string }; total: number }>>((acc, liq) => {
        const emp = liq.rrhh_novedades?.rrhh_empleados;
        if (!emp || !liq.rrhh_novedades) return acc;
        const k = String(liq.rrhh_novedades.empleado_id);
        if (!acc[k]) acc[k] = { emp, total: 0 };
        const fromMovs = liq.id != null ? sueldoMovsPorLiq?.get(liq.id) : undefined;
        acc[k].total += (fromMovs != null ? fromMovs : (liq.total_a_pagar || 0));
        return acc;
      }, {});
      const conLiq = new Set(Object.keys(gruposEmp));
      let huerfanos = 0;
      for (const [empId, items] of Object.entries(adelantosPorEmp)) {
        if (!conLiq.has(empId)) huerfanos += items.reduce((s, it) => s + it.monto, 0);
      }
      const restoSinAsignar = laborSinAsignar + huerfanos;
      const personalItems = Object.entries(gruposEmp).map(([empId, g]) => ({
        label: `${g.emp.apellido}, ${g.emp.nombre}`,
        value: g.total + (adelantosPorEmp[empId] || []).reduce((s, it) => s + it.monto, 0),
      })).sort((a, b) => b.value - a.value);
      if (restoSinAsignar > 0.5) personalItems.push({ label: "Mano de obra / otros", value: restoSinAsignar });
      if (totalCargasSociales > 0) personalItems.push({ label: "Cargas sociales", value: totalCargasSociales });
      if (totalBoletasSindicales > 0) personalItems.push({ label: "Boletas sindicales", value: totalBoletasSindicales });
      const input = {
        localNombre, mes, emitido: new Date().toLocaleDateString("es-AR"),
        ventas: ventasReales, cmv: totalCMV, utilBruta: utilBrutaReal, gastosFijosVar: totalGastos,
        sueldos, cargas: totalCargasSociales, boletas: totalBoletasSindicales,
        publicidad: totalPublicidad, comisiones: totalComisiones, impuestos: totalImpuestos,
        otros: totalOtrosGastos, utilNeta: utilNetaReal,
        porMedio: porMedio.filter(x => !/canje/i.test(x.m)).map(x => ({ label: x.m, value: x.t })),
        cmvPorCat: porCatCMV.map(x => ({ label: x.c, value: x.t })),
        gastosPorCat: [...porCatFijos, ...porCatVar].map(x => ({ label: x.c, value: x.t })).sort((a, b) => b.value - a.value),
        personalItems,
        comisionesItems: porCatCom.map(x => ({ label: x.c, value: x.t })),
        impuestosItems: porCatImp.map(x => ({ label: x.c, value: x.t })),
        marketingItems: porCatPub.map(x => ({ label: x.c, value: x.t })),
        prev: prevRes ? { ventas: prevRes.ventas, cmv: prevRes.cmv, gastosFijos: prevRes.gastosFijos, gastosVar: prevRes.gastosVar, publicidad: prevRes.publicidad, comisiones: prevRes.comisiones, impuestos: prevRes.impuestos, otrosGastos: prevRes.otrosGastos, sueldos: prevRes.sueldos, cargasSociales: prevRes.cargasSociales, utilNeta: prevRes.utilNeta } : null,
        prevMes: prevRes ? pmes : null,
        socios,
      };
      const { assembleCierre } = await import("../lib/cierre/cierreData");
      const model = assembleCierre(input);
      if (formato === "pdf") await (await import("../lib/cierre/cierrePdf")).exportCierrePdf(model);
      else await (await import("../lib/cierre/cierrePptx")).exportCierrePptx(model);
    } catch (e) {
      alert("No se pudo generar la presentación: " + (e instanceof Error ? e.message : String(e)));
    } finally { setExportando(false); }
  };

  // % delta de "compMes" vs principal para una métrica. Se usa en la tabla
  // comparativa. Para costos (CMV, gastos), un + significa que el costo
  // creció vs el principal (malo); para ingresos/utilidad, + es bueno.
  const deltaPct = (valPrincipal: number, valComp: number): { txt: string; color: string } | null => {
    if (valPrincipal === 0) return null;
    const d = ((valComp - valPrincipal) / Math.abs(valPrincipal)) * 100;
    return { txt: (d >= 0 ? "+" : "") + d.toFixed(1) + "%", color: d >= 0 ? "var(--success)" : "var(--danger)" };
  };

  // Filas del P&L como data, no como JSX. tipo distingue costos (donde "+"
  // es malo) de ingresos/utilidad (donde "+" es bueno) para colorear bien.
  const filasPyL: { label: string; key: keyof MesResumen; tipo: "ingreso" | "costo" | "util"; big?: boolean; signo?: 1 | -1 }[] = [
    { label: "Ventas Brutas", key: "ventas", tipo: "ingreso", signo: 1 },
    { label: "Compras de mercadería", key: "cmv", tipo: "costo", signo: -1 },
    { label: "Utilidad Bruta", key: "utilBruta", tipo: "util", big: true, signo: 1 },
    { label: "Gastos Fijos", key: "gastosFijos", tipo: "costo", signo: -1 },
    { label: "Gastos Variables", key: "gastosVar", tipo: "costo", signo: -1 },
    { label: "Sueldos", key: "sueldos", tipo: "costo", signo: -1 },
    { label: "Cargas Sociales", key: "cargasSociales", tipo: "costo", signo: -1 },
    { label: "Publicidad y MKT", key: "publicidad", tipo: "costo", signo: -1 },
    { label: "Comisiones", key: "comisiones", tipo: "costo", signo: -1 },
    { label: "Impuestos", key: "impuestos", tipo: "costo", signo: -1 },
    { label: "Otros Gastos", key: "otrosGastos", tipo: "costo", signo: -1 },
    { label: "Utilidad Neta", key: "utilNeta", tipo: "util", big: true, signo: 1 },
  ];

  return (
    <div>
      <div className="ph-row">
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div className="ph-title">Reportes <span style={{color:"var(--pase-text-muted)",fontWeight:400}}>· Estado de Resultados</span></div>
          <InfoTooltip maxWidth={340}>
            <strong>Reportes</strong> agrupa los distintos análisis del negocio.
            Hoy mostramos el <strong>Estado de Resultados</strong> (EERR) — mide la rentabilidad sobre base devengada:
            registra ventas, compras y gastos cuando ocurre el hecho económico, no cuando entra/sale la plata. Distinto de Caja (base percibida).
            <br /><br />
            <em>Próximamente:</em> Libro IVA, comparativo entre sucursales, evolución histórica.
          </InfoTooltip>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <input type="month" className="search" style={{width:160}} value={mes} onChange={e=>setMes(e.target.value)}/>
          {mesesComp.map((m, idx) => (
            <div key={m} style={{display:"flex",alignItems:"center",gap:4,background:"var(--s2)",border: "0.5px solid var(--bd2)",borderRadius:"var(--r)",padding:"2px 4px"}}>
              <span style={{fontSize:10,color:"var(--muted2)",marginLeft:4}}>vs</span>
              <input type="month" className="search" style={{width:130,border:"none",background:"transparent"}} value={m} onChange={e=>cambiarMesComp(idx, e.target.value)}/>
              <button type="button" onClick={()=>quitarMesComp(m)} style={{background:"transparent",border:"none",color:"var(--muted2)",cursor:"pointer",fontSize:14,padding:"0 4px"}} aria-label="Quitar mes">✕</button>
            </div>
          ))}
          {mesesComp.length < 2 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={agregarMesComp} style={{fontSize:11}}>
              + Comparar {mesesComp.length === 0 ? "mes" : "otro mes"}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" style={{fontSize:11}}
            onClick={() => setSimulando(s => !s)}
            title="Tocar las líneas del EERR y ver el impacto en la rentabilidad (no modifica datos)">
            {simulando ? "Cerrar simulador" : "Simular escenario"}
          </button>
          {esDuenoAdmin && (
            <button type="button" className="btn btn-ghost btn-sm" style={{fontSize:11}}
              disabled={localActivo == null || cerrandoMes}
              title={localActivo == null ? "Elegí un local para cerrar el mes" : (mesCerrado ? "Reabrir el mes para poder modificarlo" : "Cerrar el mes: bloquea cambios con fecha en este mes")}
              onClick={async () => {
                if (localActivo == null) return;
                const cerrar = !mesCerrado;
                if (cerrar && !confirm(`¿Cerrar ${mes}? No se va a poder crear ni editar nada con fecha en ese mes hasta reabrirlo.`)) return;
                setCerrandoMes(true);
                const { error } = cerrar
                  ? await cerrarPeriodo(localActivo, mes)
                  : await reabrirPeriodo(localActivo, mes);
                setCerrandoMes(false);
                if (error) { alert(translateRpcError(error)); return; }
                setMesCerrado(cerrar);
              }}>
              {cerrandoMes ? "..." : (mesCerrado ? "🔓 Reabrir mes" : "🔒 Cerrar mes")}
            </button>
          )}
          <div style={{ position: "relative", display: "inline-block" }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={exportando || loading}
              onClick={() => setMenuExport(o => !o)} style={{ fontSize: 11 }}
              title="Descargar el reporte del mes">
              {exportando ? "Generando..." : "⬇ Exportar ▾"}
            </button>
            {menuExport && !exportando && (
              <div style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", background: "var(--pase-bg, #fff)", border: "0.5px solid var(--pase-border-strong)", borderRadius: 8, boxShadow: "0 6px 18px rgba(20,23,31,.08)", zIndex: 30, minWidth: 250, overflow: "hidden" }}>
                {([
                  { k: "resumen", t: "Resumen (1 hoja) · PDF" },
                  { k: "cierre-pdf", t: "Presentación de cierre · PDF" },
                  { k: "cierre-pptx", t: "Presentación de cierre · PowerPoint" },
                ] as const).map(opt => (
                  <button key={opt.k} type="button" className="btn btn-ghost btn-sm"
                    style={{ display: "block", width: "100%", textAlign: "left", fontSize: 12, borderRadius: 0, padding: "8px 12px" }}
                    onClick={() => {
                      if (opt.k === "resumen") void exportarResumenUnaHoja();
                      else if (opt.k === "cierre-pdf") void exportarCierre("pdf");
                      else void exportarCierre("pptx");
                    }}>{opt.t}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {loading?<div className="loading">Cargando...</div>:(
        <>
          {simulando && (
            <EERRSimulador base={baseSimulador} mes={mes} onClose={() => setSimulando(false)} />
          )}
          {mesCerrado && (
            <div style={{margin:"4px 0 12px",padding:"6px 12px",borderRadius:8,background:"rgba(117,170,219,0.12)",fontSize:12,color:"var(--pase-text)"}}>
              🔒 Mes cerrado — no se pueden crear ni editar datos con fecha en {mes}. Reabrilo para modificarlo.
            </div>
          )}
          <div className="eerr-kpis-row">
            <div className="kpi"><div className="kpi-label">Ventas</div><div className="kpi-value-compact kpi-success">{fmt_$(totalVentas)}</div></div>
            <div className="kpi"><div className="kpi-label">Compras merc.</div><div className="kpi-value-compact kpi-warn">{fmt_$(totalCMV)}</div><div className="kpi-sub">{pct(totalCMV)}</div></div>
            <div className="kpi"><div className="kpi-label">Costo laboral</div><div className="kpi-value-compact kpi-danger">{fmt_$(sueldos+totalCargasSociales+totalBoletasSindicales)}</div><div className="kpi-sub">{pct(sueldos+totalCargasSociales+totalBoletasSindicales)}</div></div>
            <div className="kpi"><div className="kpi-label">Prime Cost</div><div className={`kpi-value-compact ${primePct<60?"kpi-success":primePct<=65?"kpi-warn":"kpi-danger"}`}>{fmt_$(primeCost)}</div><div className="kpi-sub">{pct(primeCost)} · ideal ≤60%</div></div>
            <div className="kpi"><div className="kpi-label">% Rentabilidad</div><div className={`kpi-value-compact ${utilNeta>=0?"kpi-success":"kpi-danger"}`}>{totalVentas>0?((utilNeta/totalVentas)*100).toFixed(1):"0"}%</div></div>
            <div className="kpi"><div className="kpi-label">Ganancia del mes</div><div className={`kpi-value-compact ${utilNeta>=0?"kpi-success":"kpi-danger"}`}>{fmt_$(utilNeta)}</div></div>
          </div>
          <style>{`
            /* KPIs compactados 2026-05-17 (Lucas: muy grandes + scroll horizontal).
               Grid auto-fit en vez de 5 columnas fijas → wrap a 3+2 en pantallas
               medianas en vez de scrollear. Valor 18px en vez de 28px. */
            .eerr-kpis-row {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
              gap: 10px;
              margin-bottom: 20px;
            }
            .kpi-value-compact {
              font-size: 18px;
              font-weight: 500;
              line-height: 1.1;
              color: var(--pase-text);
              letter-spacing: var(--pase-ls-tight);
              font-variant-numeric: tabular-nums;
            }
            @media (max-width: 640px) {
              .eerr-kpis-row { grid-template-columns: repeat(2, 1fr); }
              .kpi-value-compact { font-size: 16px; }
            }
          `}</style>

          {/* Gráfico de evolución — solo cuando hay >=1 mes comparado. Muestra
              tendencia de Ventas, CMV, Sueldos y Util. Neta a lo largo de
              los meses seleccionados (orden cronológico). */}
          {mesesComp.length > 0 && (
            <div className="panel" style={{marginBottom:20}}>
              <div className="panel-hd"><span className="panel-title">Evolución</span>{loadingComp && <span style={{fontSize:10,color:"var(--muted)"}}>Cargando...</span>}</div>
              <div style={{padding:"12px 8px"}}>
                <Suspense fallback={<div style={{height:220,display:"flex",alignItems:"center",justifyContent:"center",color:"var(--muted)",fontSize:11}}>Cargando gráfico…</div>}>
                  <EvolucionChart data={evolucionData} />
                </Suspense>
              </div>
            </div>
          )}

          <div className="grid2">
            <div className="panel">
              <div className="panel-hd"><span className="panel-title">Ingresos por Forma de Cobro</span></div>
              {porMedio.length===0?<div className="empty">Sin ventas este mes</div>:(
                <div>
                  {porMedio.map(x=><div key={x.m} className="eerr-row-summary"><span style={{fontSize:12,color:"var(--pase-text)"}}>{x.m}</span><div style={{textAlign:"right"}}><span style={{fontFamily:"'Inter',sans-serif",fontSize:13,fontWeight:500,color:"var(--pase-text)",fontVariantNumeric:"tabular-nums"}}>{fmt_$(x.t)}</span><span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(x.t)}</span></div></div>)}
                  <div className="eerr-row-summary" style={{borderTop: "0.5px solid var(--pase-border)",marginTop:2}}><span style={{fontSize:12,fontWeight: 500,color:"var(--pase-text)"}}>TOTAL VENTAS</span><div style={{textAlign:"right"}}><span style={{fontFamily:"'Inter',sans-serif",fontSize:13,fontWeight:500,color:"var(--success)",fontVariantNumeric:"tabular-nums"}}>{fmt_$(totalVentas)}</span><span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>100.0%</span></div></div>
                </div>
              )}
            </div>
            <div className="panel">
              <div className="panel-hd"><span className="panel-title">Resumen P&L{mesesComp.length > 0 ? ` — comparativo` : ""}</span></div>
              {mesesComp.length === 0 ? (
                <div style={{padding:"4px 0 12px"}}>
                  <ERow label="Ventas Brutas" valor={totalVentas} color="var(--pase-text)" big={false}/>
                  <ERow label="Compras de mercadería" valor={-totalCMV} color="var(--danger)" big={false}/>
                  <ERow label="Utilidad Bruta" valor={utilBruta} color={utilBruta>=0?"var(--success)":"var(--danger)"} big={true}/>
                  <ERow label="Gastos Fijos y Variables" valor={-totalGastos} color="var(--danger)" big={false}/>
                  <ERow label="Sueldos" valor={-sueldos} color="var(--danger)" big={false}/>
                  <ERow label="Cargas Sociales" valor={-totalCargasSociales} color="var(--danger)" big={false}/>
                  {totalBoletasSindicales!==0&&<ERow label="Boletas Sindicales" valor={-totalBoletasSindicales} color="var(--danger)" big={false}/>}
                  <ERow label="Publicidad y MKT" valor={-totalPublicidad} color="var(--danger)" big={false}/>
                  <ERow label="Comisiones" valor={-totalComisiones} color="var(--danger)" big={false}/>
                  <ERow label="Impuestos" valor={-totalImpuestos} color="var(--danger)" big={false}/>
                  {totalOtrosGastos!==0&&<ERow label="Otros Gastos" valor={-totalOtrosGastos} color="var(--danger)" big={false}/>}
                  <ERow label="Utilidad Neta" valor={utilNeta} color={utilNeta>=0?"var(--success)":"var(--danger)"} big={true}/>
                  {/* Retiros de socios: distribución de utilidades. NO restan
                      a Util. Neta arriba — la utilidad del negocio se ve sin
                      contar lo que se llevaron los socios. Esta sección
                      informa cuánto se distribuyó. */}
                  {totalRetiros !== 0 && (
                    <>
                      <div style={{borderTop:"1px dashed var(--bd2)",margin:"8px 0"}}/>
                      <ERow label="Retiros de Socios" valor={-totalRetiros} color="var(--info)" big={false}/>
                      <ERow label="Resultado del socio" valor={utilNetaPostRetiros} color={utilNetaPostRetiros>=0?"var(--success)":"var(--danger)"} big={false}/>
                    </>
                  )}
                </div>
              ) : (
                <div style={{padding:"4px 0 12px",overflowX:"auto"}}>
                  <table style={{width:"100%"}}>
                    <thead>
                      <tr>
                        <th style={{textAlign:"left",fontSize:9,letterSpacing:1,padding:"6px 12px"}}>Concepto</th>
                        <th style={{textAlign:"right",fontSize:9,letterSpacing:1,padding:"6px 8px"}}>{fmtMesLabel(mes)}<span style={{display:"block",fontSize:8,color:"var(--muted)",fontWeight:400}}>principal</span></th>
                        {mesesComp.slice().sort().map(mc => (
                          <th key={mc} style={{textAlign:"right",fontSize:9,letterSpacing:1,padding:"6px 8px"}}>
                            {fmtMesLabel(mc)}<span style={{display:"block",fontSize:8,color:"var(--muted)",fontWeight:400}}>vs principal</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filasPyL.map(f => {
                        const valPrincipal = resumenPrincipal[f.key] as number;
                        const sign = f.signo ?? 1;
                        const colorMain = f.tipo === "util"
                          ? (valPrincipal >= 0 ? "var(--success)" : "var(--danger)")
                          : f.tipo === "ingreso" ? "var(--success)" : "var(--danger)";
                        const showValue = (n: number) => sign === -1 && f.tipo === "costo" ? `-${fmt_$(Math.abs(n))}` : fmt_$(n);
                        return (
                          <tr key={f.label} style={f.big ? {background:"var(--s2)",fontWeight:500} : {}}>
                            <td style={{padding:f.big?"10px 12px":"6px 12px",fontSize:f.big?13:11,color:f.big?"var(--txt)":"var(--muted2)"}}>{f.label}</td>
                            <td style={{padding:f.big?"10px 8px":"6px 8px",textAlign:"right"}}>
                              <span className="num" style={{color:colorMain,fontSize:f.big?14:12}}>{showValue(valPrincipal)}</span>
                              {!f.big && <div style={{fontSize:9,color:"var(--muted)"}}>{pct(Math.abs(valPrincipal))}</div>}
                            </td>
                            {mesesComp.slice().sort().map(mc => {
                              const r = dataComp[mc];
                              if (!r) return <td key={mc} style={{padding:f.big?"10px 8px":"6px 8px",textAlign:"right",color:"var(--muted)"}}>—</td>;
                              const valComp = r[f.key] as number;
                              const colorComp = f.tipo === "util"
                                ? (valComp >= 0 ? "var(--success)" : "var(--danger)")
                                : f.tipo === "ingreso" ? "var(--success)" : "var(--danger)";
                              // Para costos, "+" significa creció (malo); invertir color del delta.
                              const rawDelta = deltaPct(valPrincipal, valComp);
                              const delta = rawDelta && f.tipo === "costo"
                                ? { ...rawDelta, color: rawDelta.txt.startsWith("+") ? "var(--danger)" : "var(--success)" }
                                : rawDelta;
                              return (
                                <td key={mc} style={{padding:f.big?"10px 8px":"6px 8px",textAlign:"right"}}>
                                  <span className="num" style={{color:colorComp,fontSize:f.big?14:12}}>{showValue(valComp)}</span>
                                  {delta && <div style={{fontSize:9,color:delta.color}}>{delta.txt}</div>}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-hd"><span className="panel-title">Detalle por Categoría</span></div>
            {porCatCMV.length > 0 && (
              <div style={{padding:"12px 4px"}}>
                <Suspense fallback={<div style={{height:120,display:"flex",alignItems:"center",justifyContent:"center",color:"var(--muted)",fontSize:11}}>Cargando gráfico…</div>}>
                  <CategoriaCMVChart data={porCatCMV.map(x=>({cat:x.c, monto:x.t}))} />
                </Suspense>
              </div>
            )}
            <ESection title="MERCADERÍA (CMV)" items={porCatCMV} total={totalCMV} color="var(--pase-text)" pct={pct} onItem={abrirCat(DETALLE_SECCIONES.cmv!)}/>
            <ESection title="GASTOS FIJOS" items={porCatFijos} total={totalGastosFijos} color="var(--pase-text)" pct={pct} onItem={abrirCat(DETALLE_SECCIONES.fijo!)}/>
            <ESection title="GASTOS VARIABLES" items={porCatVar} total={totalGastosVar} color="var(--pase-text)" pct={pct} onItem={abrirCat(DETALLE_SECCIONES.variable!)}/>
            <div
              className="eerr-section-title"
              style={{cursor:"pointer",userSelect:"none"}}
              onClick={()=>setSueldosExpanded(e=>!e)}
            >
              SUELDOS — <span style={{color:"var(--pase-text)"}}>{fmt_$(sueldos)}</span>{" "}
              <span style={{color:"var(--muted)"}}>{pct(sueldos)}</span>
              <span style={{color:"var(--muted2)",fontSize:10,marginLeft:8}}>{sueldosExpanded?"▲":"▼"}</span>
            </div>
            {sueldosExpanded&&(()=>{
              // Agrupa liquidaciones por empleado y le suma SUS adelantos
              // (pagados por fuera de la liquidación) para mostrar el sueldo
              // completo del mes por persona.
              const grupos=sueldosDetalle.reduce<Record<string,{emp:NonNullable<NonNullable<LiquidacionConEmpleado["rrhh_novedades"]>["rrhh_empleados"]>,total:number,liqs:LiquidacionConEmpleado[]}>>((acc,liq)=>{
                const emp=liq.rrhh_novedades?.rrhh_empleados;
                if(!emp) return acc;
                const k=liq.rrhh_novedades!.empleado_id;
                if(!acc[k]) acc[k]={emp,total:0,liqs:[]};
                const fromMovs=sueldoMovsPorLiq?.get(liq.id!);
                acc[k].total+=(fromMovs!=null?fromMovs:(liq.total_a_pagar||0));
                acc[k].liqs.push(liq);
                return acc;
              },{});
              const conLiq=new Set(Object.keys(grupos));
              // Adelantos de empleados SIN liquidación este mes → van a la fila
              // "sin asignar" para que el desglose cierre con el total de Sueldos.
              let huerfanos=0;
              for(const [empId,items] of Object.entries(adelantosPorEmp)){
                if(!conLiq.has(empId)) huerfanos+=items.reduce((s,i)=>s+i.monto,0);
              }
              const restoSinAsignar=laborSinAsignar+huerfanos;
              const filas=Object.entries(grupos).map(([empId,g])=>{
                const ade=adelantosPorEmp[empId]||[];
                return {emp:g.emp,liqs:g.liqs,ade,total:g.total+ade.reduce((s,i)=>s+i.monto,0)};
              }).sort((a,b)=>b.total-a.total);
              return (
                <div style={{paddingBottom:8}}>
                  {filas.length===0&&restoSinAsignar<=0.5&&especialesSueldos<=0.5?(
                    <div className="eerr-row"><span style={{fontSize:11,color:"var(--muted2)"}}>Sin sueldos pagados este mes</span></div>
                  ):(<>
                    {filas.map(({emp,total,liqs,ade})=>(
                      <div
                        key={emp.apellido+emp.nombre}
                        className="eerr-row"
                        onClick={()=>setDetalle({tipo:"sueldo",titulo:`${emp.apellido}, ${emp.nombre}`,subtitulo:emp.puesto||"",breakdown:buildSueldoBreakdown(liqs,ade),total})}
                        style={{cursor:"pointer"}}
                        title="Ver resumen de novedades"
                      >
                        <span style={{fontSize:11,color:"var(--muted2)"}}>
                          {emp.apellido}, {emp.nombre}
                          <span style={{fontSize:9,color:"var(--muted)",marginLeft:6}}>{emp.puesto}</span>
                          <span style={{fontSize:9,color:"var(--muted)",marginLeft:5}}>›</span>
                        </span>
                        <div>
                          <span className="num" style={{color:"var(--pase-text)"}}>{fmt_$(total)}</span>
                          <span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(total)}</span>
                        </div>
                      </div>
                    ))}
                    {restoSinAsignar>0.5&&(
                      <div className="eerr-row">
                        <span style={{fontSize:11,color:"var(--muted2)"}}>
                          Mano de obra / otros
                          <span style={{fontSize:9,color:"var(--muted)",marginLeft:6}}>sin empleado asignado</span>
                        </span>
                        <div>
                          <span className="num" style={{color:"var(--pase-text)"}}>{fmt_$(restoSinAsignar)}</span>
                          <span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(restoSinAsignar)}</span>
                        </div>
                      </div>
                    )}
                    {especialesSueldos>0.5&&(
                      <div className="eerr-row">
                        <span style={{fontSize:11,color:"var(--muted2)"}}>
                          Aguinaldos / vacaciones
                          <span style={{fontSize:9,color:"var(--muted)",marginLeft:6}}>SAC pagado este mes</span>
                        </span>
                        <div>
                          <span className="num" style={{color:"var(--pase-text)"}}>{fmt_$(especialesSueldos)}</span>
                          <span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(especialesSueldos)}</span>
                        </div>
                      </div>
                    )}
                  </>)}
                </div>
              );
            })()}
            {totalCargasSociales !== 0 && (
              <div className="eerr-section-title">
                CARGAS SOCIALES — <span style={{color:"var(--pase-text)"}}>{fmt_$(totalCargasSociales)}</span>{" "}
                <span style={{color:"var(--muted)"}}>{pct(totalCargasSociales)}</span>
              </div>
            )}
            {totalBoletasSindicales !== 0 && (
              <div className="eerr-section-title">
                BOLETAS SINDICALES — <span style={{color:"var(--pase-text)"}}>{fmt_$(totalBoletasSindicales)}</span>{" "}
                <span style={{color:"var(--muted)"}}>{pct(totalBoletasSindicales)}</span>
              </div>
            )}
            <ESection title="PUBLICIDAD Y MKT" items={porCatPub} total={totalPublicidad} color="var(--pase-text)" pct={pct} onItem={abrirCat(DETALLE_SECCIONES.publicidad!)}/>
            <ESection title="COMISIONES" items={porCatCom} total={totalComisiones} color="var(--pase-text)" pct={pct} onItem={abrirCat(DETALLE_SECCIONES.comision!)}/>
            <ESection title="IMPUESTOS" items={porCatImp} total={totalImpuestos} color="var(--pase-text)" pct={pct} onItem={abrirCat(DETALLE_SECCIONES.impuesto!)}/>
            {porCatOtros.length>0&&<ESection title="OTROS GASTOS" items={porCatOtros} total={totalOtrosGastos} color="var(--pase-text)" pct={pct} onItem={abrirCat(DETALLE_SECCIONES.otros!)}/>}
            {totalRetiros !== 0 && (
              <ESection title="RETIROS DE SOCIOS (post Util. Neta)" items={porCatRet} total={totalRetiros} color="var(--pase-text)" pct={pct} onItem={abrirCat(DETALLE_SECCIONES.retiro!)}/>
            )}
          </div>
        </>
      )}
      {detalle && (
        <EERRDetalleModal
          state={detalle}
          mes={mes}
          localActivo={localActivo}
          user={user}
          onClose={()=>setDetalle(null)}
        />
      )}
    </div>
  );
}

function ESection({title,items,total,color,pct,onItem}: {title: string, items: {c?: string, m?: string, t: number}[], total: number, color: string, pct: (n: number) => string, onItem?: (cat: string) => void}) {
  const [open,setOpen]=useState(false);
  return (
    <>
      <div className="eerr-section-title" style={{cursor:"pointer",userSelect:"none"}} onClick={()=>setOpen(o=>!o)}>
        {title} — <span style={{color}}>{fmt_$(total)}</span> <span style={{color:"var(--muted)"}}>{pct(total)}</span>
        <span style={{color:"var(--muted2)",fontSize:10,marginLeft:8}}>{open?"▲":"▼"}</span>
      </div>
      {open&&items.map(x=>{
        const cat=x.c||x.m;
        const clickable=!!onItem&&!!cat;
        return (
          <div
            key={cat}
            className="eerr-row"
            onClick={clickable?()=>onItem!(cat!):undefined}
            style={clickable?{cursor:"pointer"}:undefined}
            title={clickable?"Ver detalle":undefined}
          >
            <span style={{fontSize:11,color:"var(--muted2)"}}>{cat}{clickable&&<span style={{fontSize:9,color:"var(--muted)",marginLeft:5}}>›</span>}</span>
            <div><span className="num" style={{color}}>{fmt_$(x.t)}</span><span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(x.t)}</span></div>
          </div>
        );
      })}
    </>
  );
}