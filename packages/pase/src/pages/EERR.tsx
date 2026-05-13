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
import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope } from "../lib/auth";
import { useCategorias } from "../lib/useCategorias";
import { useMediosCobro } from "../lib/useMediosCobro";
import { toISO, today, fmt_$ } from "../lib/utils";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line, Legend, CartesianGrid } from "recharts";
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
  sueldos: number;
  utilBruta: number;
  utilNeta: number;
}

interface LiquidacionPendienteRow {
  total_a_pagar: number;
  rrhh_novedades: { rrhh_empleados: { local_id: number | null } | null } | null;
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
  const [sueldosDetalle,setSueldosDetalle]=useState<LiquidacionConEmpleado[]>([]);
  const [sueldosExpanded,setSueldosExpanded]=useState(false);
  const [mes,setMes]=useState(toISO(today).slice(0,7));
  const [loading,setLoading]=useState(true);
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
    let fq = db.from("facturas").select("total, local_id").gte("fecha", desde).lte("fecha", hasta).neq("estado", "anulada");
    fq = applyLocalScope(fq, user, lid);
    let gq = db.from("gastos").select("monto, tipo, categoria, local_id").gte("fecha", desde).lte("fecha", hasta);
    gq = applyLocalScope(gq, user, lid);
    const [{ data: v }, { data: f }, { data: g0 }, { data: liq }] = await Promise.all([
      vq, fq, gq,
      db.from("rrhh_liquidaciones")
        .select("total_a_pagar, rrhh_novedades(rrhh_empleados(local_id))")
        .in("estado", ["pendiente", "pagado"]).eq("anulado", false)
        .gte("calculado_at", desde + "T00:00:00").lte("calculado_at", hasta + "T23:59:59"),
    ]);
    const ventasArr = (v as Venta[]) || [];
    const facturasArr = (f as Factura[]) || [];
    const gastosArr = ((g0 as Gasto[]) || []).filter(x => x.categoria !== "SUELDOS");
    const liqRows = ((liq as unknown) as LiquidacionPendienteRow[]) || [];
    const ventas = ventasArr.reduce((s, x) => s + Number(x.monto), 0);
    // Clasificación por bucket: facturas legacy (bucket=null) o cat_compra
    // suman al CMV; el resto suma a su bucket de gastos correspondiente.
    const facsCMV = facturasArr.filter(x => !x.bucket || x.bucket === "cat_compra");
    const facsBucket = (b: string) => facturasArr.filter(x => x.bucket === b);
    const sumF = (arr: Factura[]) => arr.reduce((s, x) => s + Number(x.total), 0);
    const cmv = sumF(facsCMV);
    const gastosFijos = gastosArr.filter(x => x.tipo === "fijo").reduce((s, x) => s + Number(x.monto), 0) + sumF(facsBucket("gasto_fijo"));
    const gastosVar = gastosArr.filter(x => x.tipo === "variable").reduce((s, x) => s + Number(x.monto), 0) + sumF(facsBucket("gasto_variable"));
    const publicidad = gastosArr.filter(x => x.tipo === "publicidad").reduce((s, x) => s + Number(x.monto), 0) + sumF(facsBucket("gasto_publicidad"));
    const comisiones = gastosArr.filter(x => x.tipo === "comision").reduce((s, x) => s + Number(x.monto), 0) + sumF(facsBucket("gasto_comision"));
    const impuestos = gastosArr.filter(x => x.tipo === "impuesto").reduce((s, x) => s + Number(x.monto), 0) + sumF(facsBucket("gasto_impuesto"));
    const liqFilt = liqRows.filter(l => !lid || (l.rrhh_novedades?.rrhh_empleados?.local_id === lid));
    const sueldos = liqFilt.reduce((s, l) => s + Number(l.total_a_pagar), 0);
    const utilBruta = ventas - cmv;
    const utilNeta = utilBruta - gastosFijos - gastosVar - sueldos - publicidad - comisiones - impuestos;
    return { mes: mesArg, ventas, cmv, gastosFijos, gastosVar, publicidad, comisiones, impuestos, sueldos, utilBruta, utilNeta };
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
      let vq = db.from("ventas").select("*").gte("fecha",desde).lte("fecha",hasta);
      vq = applyLocalScope(vq, user, lid);
      let fq = db.from("facturas").select("*").gte("fecha",desde).lte("fecha",hasta).neq("estado","anulada");
      fq = applyLocalScope(fq, user, lid);
      let gq = db.from("gastos").select("*").gte("fecha",desde).lte("fecha",hasta);
      gq = applyLocalScope(gq, user, lid);
      const [{data:v},{data:f},{data:g},{data:liqData}]=await Promise.all([
        vq,
        fq,
        gq,
        db.from("rrhh_liquidaciones")
          .select("*, rrhh_novedades(mes, anio, empleado_id, rrhh_empleados(nombre, apellido, puesto, local_id))")
          .in("estado", ["pendiente", "pagado"])
          .eq("anulado", false)
          .gte("calculado_at", desde+"T00:00:00")
          .lte("calculado_at", hasta+"T23:59:59"),
      ]);
      setVentas((v as Venta[]) || []);
      setFacturas((f as Factura[]) || []);
      setGastos(((g as Gasto[]) || []).filter((x) => x.categoria !== "SUELDOS"));
      // El cast a unknown primero salva el mismatch entre lo que Supabase tipa
      // (nested FK como array) y la realidad 1:1 que LiquidacionConEmpleado
      // refleja — convención existente del codebase, ver comentario del type.
      const liqRows = ((liqData as unknown) as LiquidacionConEmpleado[]) || [];
      const liqFiltradas = liqRows.filter((l) => {
        const emp = l.rrhh_novedades?.rrhh_empleados;
        return !lid || (emp ? emp.local_id === lid : false);
      });
      setSueldosDetalle(liqFiltradas);
      setSueldos(liqFiltradas.reduce((s, l) => s + (l.total_a_pagar || 0), 0));
      setLoading(false);
    };
    load();
  // user no cambia durante el lifecycle (App desmonta en logout).
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const totalGastosFijos=gastos.filter((g)=>g.tipo==="fijo").reduce((s, g)=>s+(g.monto||0),0)+sumarMonto(facturasBucket("gasto_fijo"),"total");
  const totalGastosVar=gastos.filter((g)=>g.tipo==="variable").reduce((s, g)=>s+(g.monto||0),0)+sumarMonto(facturasBucket("gasto_variable"),"total");
  const totalPublicidad=gastos.filter((g)=>g.tipo==="publicidad").reduce((s, g)=>s+(g.monto||0),0)+sumarMonto(facturasBucket("gasto_publicidad"),"total");
  const totalComisiones=gastos.filter((g)=>g.tipo==="comision").reduce((s, g)=>s+(g.monto||0),0)+sumarMonto(facturasBucket("gasto_comision"),"total");
  const totalImpuestos=gastos.filter((g)=>g.tipo==="impuesto").reduce((s, g)=>s+(g.monto||0),0)+sumarMonto(facturasBucket("gasto_impuesto"),"total");
  // Retiros de socios: distribución de utilidades, NO suma a gastos
  // operativos. Se muestra DESPUÉS de Util. Neta. Solo se cargan via la
  // pantalla Gastos (no facturas).
  const totalRetiros=gastos.filter((g)=>g.tipo==="retiro_socio").reduce((s, g)=>s+(g.monto||0),0);
  const totalGastos=totalGastosFijos+totalGastosVar;
  const utilBruta=totalVentas-totalCMV;
  const utilNeta=utilBruta-totalGastos-sueldos-totalPublicidad-totalComisiones-totalImpuestos;
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
  // Detalle por categoría: cada bucket suma sus categorías de gastos +
  // las facturas con ese bucket. Las facturas con bucket=cat_compra (o
  // legacy null) van al CMV junto con CATEGORIAS_COMPRA del catálogo.
  const tFactCat = (cat: string, bucket: string | null) =>
    facturas.filter(f => f.cat === cat && (bucket === null
      ? (!f.bucket || f.bucket === "cat_compra")
      : f.bucket === bucket
    )).reduce((s, f) => s + Number(f.total || 0), 0);
  const tGastoCat = (cat: string, tipo: string) =>
    gastos.filter(g => g.tipo === tipo && g.categoria === cat).reduce((s, g) => s + Number(g.monto || 0), 0);

  const porCatCMV=CATEGORIAS_COMPRA.map(c=>({c,t:tFactCat(c, null)})).filter(x=>x.t>0).sort((a,b)=>b.t-a.t);
  const porCatFijos=GASTOS_FIJOS.map(c=>({c,t:tGastoCat(c, "fijo") + tFactCat(c, "gasto_fijo")})).filter(x=>x.t>0);
  const porCatVar=GASTOS_VARIABLES.map(c=>({c,t:tGastoCat(c, "variable") + tFactCat(c, "gasto_variable")})).filter(x=>x.t>0);
  const porCatPub=GASTOS_PUBLICIDAD.map(c=>({c,t:tGastoCat(c, "publicidad") + tFactCat(c, "gasto_publicidad")})).filter(x=>x.t>0);
  const porCatCom=COMISIONES_CATS.map(c=>({c,t:tGastoCat(c, "comision") + tFactCat(c, "gasto_comision")})).filter(x=>x.t>0);
  const porCatImp=GASTOS_IMPUESTOS.map(c=>({c,t:tGastoCat(c, "impuesto") + tFactCat(c, "gasto_impuesto")})).filter(x=>x.t>0);
  const porCatRet=RETIROS_SOCIOS.map(c=>({c,t:tGastoCat(c, "retiro_socio")})).filter(x=>x.t>0);

  const ERow=({label,valor,color,big}: {label: string, valor: number, color: string, big?: boolean})=>(
    <div className="eerr-row" style={big?{background:"var(--s2)",padding:"12px 16px"}:{}}>
      <span style={{fontSize:big?13:11,fontWeight:big?600:400,color:big?"var(--txt)":"var(--muted2)"}}>{label}</span>
      <div>
        <span style={{fontFamily:"'Inter',sans-serif",fontSize:big?17:13,fontWeight:500,color}}>{fmt_$(valor)}</span>
        {!big&&<span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(Math.abs(valor))}</span>}
      </div>
    </div>
  );

  const ESection=({title,items,total,color}: {title: string, items: {c?: string, m?: string, t: number}[], total: number, color: string})=>(
    <>
      <div className="eerr-section-title">{title} — <span style={{color}}>{fmt_$(total)}</span> <span style={{color:"var(--muted)"}}>{pct(total)}</span></div>
      {items.map(x=><div key={x.c||x.m} className="eerr-row"><span style={{fontSize:11,color:"var(--muted2)"}}>{x.c||x.m}</span><div><span className="num" style={{color}}>{fmt_$(x.t)}</span><span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(x.t)}</span></div></div>)}
    </>
  );

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
    sueldos,
    utilBruta,
    utilNeta,
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
    CMV: Math.round(r.cmv),
    Sueldos: Math.round(r.sueldos),
    "Util. Neta": Math.round(r.utilNeta),
  }));

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
    { label: "(-) CMV", key: "cmv", tipo: "costo", signo: -1 },
    { label: "(=) Utilidad Bruta", key: "utilBruta", tipo: "util", big: true, signo: 1 },
    { label: "(-) Gastos Fijos", key: "gastosFijos", tipo: "costo", signo: -1 },
    { label: "(-) Gastos Variables", key: "gastosVar", tipo: "costo", signo: -1 },
    { label: "(-) Sueldos", key: "sueldos", tipo: "costo", signo: -1 },
    { label: "(-) Publicidad y MKT", key: "publicidad", tipo: "costo", signo: -1 },
    { label: "(-) Comisiones", key: "comisiones", tipo: "costo", signo: -1 },
    { label: "(-) Impuestos", key: "impuestos", tipo: "costo", signo: -1 },
    { label: "(=) Utilidad Neta", key: "utilNeta", tipo: "util", big: true, signo: 1 },
  ];

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Estado de Resultados</div></div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <input type="month" className="search" style={{width:160}} value={mes} onChange={e=>setMes(e.target.value)}/>
          {mesesComp.map((m, idx) => (
            <div key={m} style={{display:"flex",alignItems:"center",gap:4,background:"var(--s2)",border:"1px solid var(--bd2)",borderRadius:"var(--r)",padding:"2px 4px"}}>
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
        </div>
      </div>
      {loading?<div className="loading">Cargando...</div>:(
        <>
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12,marginBottom:20}}>
            <div className="kpi"><div className="kpi-label">Ventas</div><div className="kpi-value kpi-success">{fmt_$(totalVentas)}</div></div>
            <div className="kpi"><div className="kpi-label">CMV</div><div className="kpi-value kpi-warn">{fmt_$(totalCMV)}</div><div className="kpi-sub">{pct(totalCMV)}</div></div>
            <div className="kpi"><div className="kpi-label">Labor Cost</div><div className="kpi-value kpi-danger">{fmt_$(sueldos)}</div><div className="kpi-sub">{pct(sueldos)}</div></div>
            <div className="kpi"><div className="kpi-label">% Rentabilidad</div><div className={`kpi-value ${utilNeta>=0?"kpi-success":"kpi-danger"}`}>{totalVentas>0?((utilNeta/totalVentas)*100).toFixed(1):"0"}%</div></div>
            <div className="kpi"><div className="kpi-label">Ganancia del mes</div><div className={`kpi-value ${utilNeta>=0?"kpi-success":"kpi-danger"}`}>{fmt_$(utilNeta)}</div></div>
          </div>

          {/* Gráfico de evolución — solo cuando hay >=1 mes comparado. Muestra
              tendencia de Ventas, CMV, Sueldos y Util. Neta a lo largo de
              los meses seleccionados (orden cronológico). */}
          {mesesComp.length > 0 && (
            <div className="panel" style={{marginBottom:20}}>
              <div className="panel-hd"><span className="panel-title">Evolución</span>{loadingComp && <span style={{fontSize:10,color:"var(--muted)"}}>Cargando...</span>}</div>
              <div style={{padding:"12px 8px"}}>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={evolucionData} margin={{top:8,right:24,left:8,bottom:0}}>
                    <CartesianGrid stroke="var(--bd2)" strokeDasharray="3 3"/>
                    <XAxis dataKey="mes" tick={{fontSize:10,fill:"var(--muted)"}} axisLine={{stroke:"var(--bd2)"}} tickLine={false}/>
                    <YAxis tick={{fontSize:10,fill:"var(--muted)"}} axisLine={false} tickLine={false} tickFormatter={(v)=>{
                      const n = Number(v);
                      if (Math.abs(n) >= 1_000_000) return (n/1_000_000).toFixed(1)+"M";
                      if (Math.abs(n) >= 1_000) return Math.round(n/1_000)+"k";
                      return String(n);
                    }}/>
                    <Tooltip
                      contentStyle={{background:"var(--s1)",border:"1px solid var(--bd2)",borderRadius:6,fontSize:11}}
                      formatter={(v)=>[`$${Number(v).toLocaleString("es-AR")}`] as [string]}
                    />
                    <Legend wrapperStyle={{fontSize:11}}/>
                    <Line type="monotone" dataKey="Ventas" stroke="var(--success)" strokeWidth={2} dot={{r:3}} />
                    <Line type="monotone" dataKey="CMV" stroke="var(--warn)" strokeWidth={2} dot={{r:3}} />
                    <Line type="monotone" dataKey="Sueldos" stroke="var(--danger)" strokeWidth={2} dot={{r:3}} />
                    <Line type="monotone" dataKey="Util. Neta" stroke="var(--acc)" strokeWidth={2} dot={{r:3}} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <div className="grid2">
            <div className="panel">
              <div className="panel-hd"><span className="panel-title">Ingresos por Forma de Cobro</span></div>
              {porMedio.length===0?<div className="empty">Sin ventas este mes</div>:(
                <div>
                  {porMedio.map(x=><div key={x.m} className="eerr-row"><span style={{fontSize:11}}>{x.m}</span><div><span className="num kpi-success">{fmt_$(x.t)}</span><span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(x.t)}</span></div></div>)}
                  <div className="eerr-row" style={{background:"var(--s2)"}}><span style={{fontWeight:500}}>TOTAL VENTAS</span><span style={{fontFamily:"'Inter',sans-serif",fontSize:15,fontWeight:500,color:"var(--success)"}}>{fmt_$(totalVentas)}</span></div>
                </div>
              )}
            </div>
            <div className="panel">
              <div className="panel-hd"><span className="panel-title">Resumen P&L{mesesComp.length > 0 ? ` — comparativo` : ""}</span></div>
              {mesesComp.length === 0 ? (
                <div style={{padding:"4px 0 12px"}}>
                  <ERow label="Ventas Brutas" valor={totalVentas} color="var(--success)" big={false}/>
                  <ERow label="(-) CMV" valor={-totalCMV} color="var(--danger)" big={false}/>
                  <ERow label="(=) Utilidad Bruta" valor={utilBruta} color={utilBruta>=0?"var(--success)":"var(--danger)"} big={true}/>
                  <ERow label="(-) Gastos Fijos y Variables" valor={-totalGastos} color="var(--danger)" big={false}/>
                  <ERow label="(-) Sueldos" valor={-sueldos} color="var(--danger)" big={false}/>
                  <ERow label="(-) Publicidad y MKT" valor={-totalPublicidad} color="var(--danger)" big={false}/>
                  <ERow label="(-) Comisiones" valor={-totalComisiones} color="var(--danger)" big={false}/>
                  <ERow label="(-) Impuestos" valor={-totalImpuestos} color="var(--danger)" big={false}/>
                  <ERow label="(=) Utilidad Neta" valor={utilNeta} color={utilNeta>=0?"var(--success)":"var(--danger)"} big={true}/>
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
                <ResponsiveContainer width="100%" height={120}>
                  <BarChart data={porCatCMV.map(x=>({cat:x.c, monto:x.t}))} margin={{top:0,right:8,left:0,bottom:0}}>
                    <XAxis dataKey="cat" tick={{fontSize:9,fill:"var(--muted)"}} axisLine={false} tickLine={false}/>
                    <YAxis hide/>
                    <Tooltip
                      contentStyle={{background:"var(--s1)",border:"1px solid var(--bd2)",borderRadius:6,fontSize:11}}
                      formatter={(v)=>[`$${Number(v).toLocaleString("es-AR")}`, "CMV"] as [string, string]}
                    />
                    <Bar dataKey="monto" radius={[4,4,0,0]}>
                      {porCatCMV.map((_,i)=><Cell key={i} fill={i===0?"var(--warn)":i===1?"var(--acc)":"var(--info)"}/>)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            <ESection title="MERCADERÍA (CMV)" items={porCatCMV} total={totalCMV} color="var(--warn)"/>
            <ESection title="GASTOS FIJOS" items={porCatFijos} total={totalGastosFijos} color="var(--danger)"/>
            <ESection title="GASTOS VARIABLES" items={porCatVar} total={totalGastosVar} color="var(--danger)"/>
            <div
              className="eerr-section-title"
              style={{cursor:"pointer",userSelect:"none"}}
              onClick={()=>setSueldosExpanded(e=>!e)}
            >
              SUELDOS — <span style={{color:"var(--danger)"}}>{fmt_$(sueldos)}</span>{" "}
              <span style={{color:"var(--muted)"}}>{pct(sueldos)}</span>
              <span style={{color:"var(--muted2)",fontSize:10,marginLeft:8}}>{sueldosExpanded?"▲ ocultar":"▼ ver detalle"}</span>
            </div>
            {sueldosExpanded&&(
              <div style={{paddingBottom:8}}>
                {sueldosDetalle.length===0?(
                  <div className="eerr-row"><span style={{fontSize:11,color:"var(--muted2)"}}>Sin sueldos pagados este mes</span></div>
                ):sueldosDetalle.map((liq,i)=>{
                  const emp=liq.rrhh_novedades?.rrhh_empleados;
                  if(!emp) return null;
                  return (
                    <div key={i} className="eerr-row">
                      <span style={{fontSize:11,color:"var(--muted2)"}}>
                        {emp.apellido}, {emp.nombre}
                        <span style={{fontSize:9,color:"var(--muted)",marginLeft:6}}>{emp.puesto}</span>
                      </span>
                      <div>
                        <span className="num" style={{color:"var(--danger)"}}>{fmt_$(liq.total_a_pagar)}</span>
                        <span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(liq.total_a_pagar)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <ESection title="PUBLICIDAD Y MKT" items={porCatPub} total={totalPublicidad} color="var(--info)"/>
            <ESection title="COMISIONES" items={porCatCom} total={totalComisiones} color="var(--acc2)"/>
            <ESection title="IMPUESTOS" items={porCatImp} total={totalImpuestos} color="var(--danger)"/>
            {totalRetiros !== 0 && (
              <ESection title="RETIROS DE SOCIOS (post Util. Neta)" items={porCatRet} total={totalRetiros} color="var(--info)"/>
            )}
          </div>
        </>
      )}
    </div>
  );
}