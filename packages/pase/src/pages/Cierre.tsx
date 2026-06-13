import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope } from "../lib/auth";
import { toISO, fmt_$ } from "@pase/shared/utils";
import { today } from "../lib/utils";
import type { Usuario } from "../types/auth";
import type { Venta, Factura, Gasto } from "../types/finanzas";

interface CierreProps {
  user: Usuario;
  localActivo: number | null;
}

// Datos calculados del mes (cargarMes() devuelve esta forma).
interface MesData {
  ventas: number;
  cmv: number;
  gastosFijos: number;
  gastosVar: number;
  publicidad: number;
  comisiones: number;
  impuestos: number;
  cargasSociales: number;
  otrosGastos: number;
  sueldos: number;
  utilBruta: number;
  utilNeta: number;
  pct: (n: number) => string;
}

// Subset de Liquidacion + nested join (mismo patrón que Cashflow).
interface LiquidacionPendienteRow {
  id: string;
  total_a_pagar: number;
  rrhh_novedades: { mes: number; anio: number; rrhh_empleados: { local_id: number | null } | null } | null;
}

export default function Cierre({ user, localActivo }: CierreProps) {
  const hoy = toISO(today).slice(0, 7);
  // Default: mes actual vs mes anterior
  const mesAnterior = (() => {
    const [yr, mo] = hoy.split("-").map(Number) as [number, number];
    return mo === 1 ? `${yr-1}-12` : `${yr}-${String(mo-1).padStart(2,"0")}`;
  })();

  const [mesA, setMesA] = useState(mesAnterior);
  const [mesB, setMesB] = useState(hoy);
  const [dataA, setDataA] = useState<MesData | null>(null);
  const [dataB, setDataB] = useState<MesData | null>(null);
  const [loading, setLoading] = useState(false);

  const cargarMes = async (mes: string): Promise<MesData> => {
    const [yr, mo] = mes.split("-").map(Number) as [number, number];
    const lastDay = new Date(yr, mo, 0).getDate();
    const desde = mes + "-01";
    const hasta = mes + "-" + String(lastDay).padStart(2, "0");
    const lid = localActivo ? parseInt(String(localActivo)) : null;

    let vq = db.from("ventas").select("monto, local_id").gte("fecha", desde).lte("fecha", hasta);
    vq = applyLocalScope(vq, user, lid);
    let fq = db.from("facturas").select("total, local_id").gte("fecha", desde).lte("fecha", hasta).neq("estado", "anulada");
    fq = applyLocalScope(fq, user, lid);
    let gq = db.from("gastos").select("monto, tipo, categoria, local_id").gte("fecha", desde).lte("fecha", hasta);
    gq = applyLocalScope(gq, user, lid);
    const [{ data: v }, { data: f }, { data: g0 }, { data: liq }, { data: sMov }] = await Promise.all([
      vq,
      fq,
      gq,
      db.from("rrhh_liquidaciones")
        .select("id, total_a_pagar, rrhh_novedades(mes, anio, rrhh_empleados(local_id))")
        .in("estado", ["pendiente", "pagado"]).eq("anulado", false),
      db.from("movimientos")
        .select("importe, local_id, liquidacion_id")
        .eq("cat", "SUELDOS").eq("anulado", false)
        .not("liquidacion_id", "is", null),
    ]);
    const ventas_arr = (v as Venta[]) || [];
    const facturas_arr = (f as Factura[]) || [];
    const allGastos = ((g0 as Gasto[]) || []).filter(x => x.categoria !== "SUELDOS");
    const gastosEmp = allGastos.filter(x => x.tipo === "empleado");
    const gastos_arr = allGastos.filter(x => x.tipo !== "empleado");
    const liqRows = (((liq as unknown) as LiquidacionPendienteRow[]) || [])
      .filter(l => l.rrhh_novedades?.mes === mo && l.rrhh_novedades?.anio === yr);
    const liqIdSet = new Set(liqRows.map(l => l.id));
    const sueldoMovsCierre = ((sMov as {importe:number,local_id:number,liquidacion_id:string}[]) || [])
      .filter(m => liqIdSet.has(m.liquidacion_id));

    const ventas = ventas_arr.reduce((s, x) => s + Number(x.monto), 0);
    const cmv = facturas_arr.reduce((s, x) => s + Number(x.total), 0);
    const cargasSociales = gastos_arr.filter(x => x.tipo === "fijo" && x.categoria === "CARGAS SOCIALES").reduce((s, x) => s + Number(x.monto), 0);
    const gastosFijos = gastos_arr.filter(x => x.tipo === "fijo" && x.categoria !== "CARGAS SOCIALES").reduce((s, x) => s + Number(x.monto), 0);
    const gastosVar = gastos_arr.filter(x => x.tipo === "variable").reduce((s, x) => s + Number(x.monto), 0);
    const publicidad = gastos_arr.filter(x => x.tipo === "publicidad").reduce((s, x) => s + Number(x.monto), 0);
    const comisiones = gastos_arr.filter(x => x.tipo === "comision").reduce((s, x) => s + Number(x.monto), 0);
    const impuestos = gastos_arr.filter(x => x.tipo === "impuesto").reduce((s, x) => s + Number(x.monto), 0);
    const otrosGastos = gastos_arr.filter(x => !["fijo","variable","publicidad","comision","impuesto","retiro_socio","empleado"].includes(x.tipo)).reduce((s, x) => s + Number(x.monto), 0);
    let sueldos: number;
    const gastosEmpFilt = gastosEmp.filter(x => !lid || x.local_id === lid);
    if (lid) {
      const movsPorLiq = new Map<string,number>();
      for (const m of sueldoMovsCierre) {
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
    const pct = (n: number) => ventas > 0 ? ((n / ventas) * 100).toFixed(1) + "%" : "—";

    return { ventas, cmv, gastosFijos, gastosVar, publicidad, comisiones, impuestos, cargasSociales, otrosGastos, sueldos, utilBruta, utilNeta, pct };
  };

  const cargar = async () => {
    setLoading(true);
    const [a, b] = await Promise.all([cargarMes(mesA), cargarMes(mesB)]);
    setDataA(a);
    setDataB(b);
    setLoading(false);
  };

  // Patrón fetch-on-dep-change. No agregar cargar a deps (re-fetch infinito).
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { cargar(); }, [mesA, mesB, localActivo]);

  const diff = (a: number, b: number) => {
    const d = b - a;
    const pct = a !== 0 ? ((d / Math.abs(a)) * 100).toFixed(1) + "%" : "—";
    return { d, pct, color: d >= 0 ? "var(--success)" : "var(--danger)" };
  };

  // Para costos (positivo es malo → invertir color)
  const diffCosto = (a: number, b: number) => {
    const d = b - a;
    const pct = a !== 0 ? ((d / Math.abs(a)) * 100).toFixed(1) + "%" : "—";
    return { d, pct, color: d <= 0 ? "var(--success)" : "var(--danger)" };
  };

  const FILAS = dataA && dataB ? [
    { label: "Ventas Brutas", a: dataA.ventas, b: dataB.ventas, tipo: "ingreso", big: false },
    { label: "CMV", a: dataA.cmv, b: dataB.cmv, tipo: "costo", big: false },
    { label: "Utilidad Bruta", a: dataA.utilBruta, b: dataB.utilBruta, tipo: "util", big: true },
    { label: "Gastos Fijos", a: dataA.gastosFijos, b: dataB.gastosFijos, tipo: "costo", big: false },
    { label: "Gastos Variables", a: dataA.gastosVar, b: dataB.gastosVar, tipo: "costo", big: false },
    { label: "Sueldos", a: dataA.sueldos, b: dataB.sueldos, tipo: "costo", big: false },
    { label: "Cargas Sociales", a: dataA.cargasSociales, b: dataB.cargasSociales, tipo: "costo", big: false },
    { label: "Publicidad", a: dataA.publicidad, b: dataB.publicidad, tipo: "costo", big: false },
    { label: "Comisiones", a: dataA.comisiones, b: dataB.comisiones, tipo: "costo", big: false },
    { label: "Impuestos", a: dataA.impuestos, b: dataB.impuestos, tipo: "costo", big: false },
    ...(dataA.otrosGastos||dataB.otrosGastos?[{ label: "Otros Gastos", a: dataA.otrosGastos, b: dataB.otrosGastos, tipo: "costo", big: false }]:[]),
    { label: "Utilidad Neta", a: dataA.utilNeta, b: dataB.utilNeta, tipo: "util", big: true },
  ] : [];

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Cierre Comparativo</div></div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input type="month" className="search" style={{ width: 150 }} value={mesA} onChange={e => setMesA(e.target.value)} />
          <span style={{ color: "var(--muted2)", fontSize: 12 }}>vs</span>
          <input type="month" className="search" style={{ width: 150 }} value={mesB} onChange={e => setMesB(e.target.value)} />
        </div>
      </div>

      {loading ? <div className="loading">Cargando...</div> : dataA && dataB && (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th style={{ width: "30%" }}>Concepto</th>
                <th style={{ textAlign: "right" }}>{mesA}</th>
                <th style={{ textAlign: "right" }}>{mesB}</th>
                <th style={{ textAlign: "right" }}>Diferencia</th>
                <th style={{ textAlign: "right" }}>%</th>
              </tr>
            </thead>
            <tbody>
              {FILAS.map(fila => {
                const { d, pct, color } = fila.tipo === "costo"
                  ? diffCosto(fila.a, fila.b)
                  : diff(fila.a, fila.b);
                const colorA = fila.tipo === "util"
                  ? fila.a >= 0 ? "var(--success)" : "var(--danger)"
                  : "var(--txt)";
                const colorB = fila.tipo === "util"
                  ? fila.b >= 0 ? "var(--success)" : "var(--danger)"
                  : "var(--txt)";
                return (
                  <tr key={fila.label} style={fila.big ? { background: "var(--s2)", fontWeight:500 } : {}}>
                    <td style={{ fontSize: fila.big ? 13 : 11, color: fila.big ? "var(--txt)" : "var(--muted2)" }}>
                      {fila.label}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <span className="num" style={{ color: colorA }}>{fmt_$(fila.a)}</span>
                      {!fila.big && dataA.pct && <span style={{ fontSize: 9, color: "var(--muted)", marginLeft: 4 }}>{dataA.pct(fila.a)}</span>}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <span className="num" style={{ color: colorB }}>{fmt_$(fila.b)}</span>
                      {!fila.big && dataB.pct && <span style={{ fontSize: 9, color: "var(--muted)", marginLeft: 4 }}>{dataB.pct(fila.b)}</span>}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <span className="num" style={{ color }}>{d >= 0 ? "+" : ""}{fmt_$(d)}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <span style={{ fontSize: 11, color }}>{d >= 0 ? "+" : ""}{pct}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
