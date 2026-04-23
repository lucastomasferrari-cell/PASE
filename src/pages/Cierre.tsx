import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope } from "../lib/auth";
import { toISO, today, fmt_$ } from "../lib/utils";

export default function Cierre({ user, locales, localActivo }: any) {
  const hoy = toISO(today).slice(0, 7);
  // Default: mes actual vs mes anterior
  const mesAnterior = (() => {
    const [yr, mo] = hoy.split("-").map(Number);
    return mo === 1 ? `${yr-1}-12` : `${yr}-${String(mo-1).padStart(2,"0")}`;
  })();

  const [mesA, setMesA] = useState(mesAnterior);
  const [mesB, setMesB] = useState(hoy);
  const [dataA, setDataA] = useState<any>(null);
  const [dataB, setDataB] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const cargarMes = async (mes: string) => {
    const [yr, mo] = mes.split("-").map(Number);
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
    const [{ data: v }, { data: f }, { data: g0 }, { data: liq }] = await Promise.all([
      vq,
      fq,
      gq,
      db.from("rrhh_liquidaciones")
        .select("total_a_pagar, rrhh_novedades(rrhh_empleados(local_id))")
        .in("estado", ["pendiente", "pagado"]).eq("anulado", false)
        .gte("calculado_at", desde + "T00:00:00").lte("calculado_at", hasta + "T23:59:59"),
    ]);
    const g = (g0 || []).filter((x: any) => x.categoria !== "SUELDOS");

    const ventas = (v || []).reduce((s: number, x: any) => s + Number(x.monto), 0);
    const cmv = (f || []).reduce((s: number, x: any) => s + Number(x.total), 0);
    const gastosFijos = (g || []).filter((x: any) => x.tipo === "fijo").reduce((s: number, x: any) => s + Number(x.monto), 0);
    const gastosVar = (g || []).filter((x: any) => x.tipo === "variable").reduce((s: number, x: any) => s + Number(x.monto), 0);
    const publicidad = (g || []).filter((x: any) => x.tipo === "publicidad").reduce((s: number, x: any) => s + Number(x.monto), 0);
    const liqFilt = (liq || []).filter((l: any) => !lid || parseInt(l.rrhh_novedades?.rrhh_empleados?.local_id) === lid);
    const sueldos = liqFilt.reduce((s: number, l: any) => s + Number(l.total_a_pagar), 0);
    const utilBruta = ventas - cmv;
    const utilNeta = utilBruta - gastosFijos - gastosVar - sueldos - publicidad;
    const pct = (n: number) => ventas > 0 ? ((n / ventas) * 100).toFixed(1) + "%" : "—";

    return { ventas, cmv, gastosFijos, gastosVar, publicidad, sueldos, utilBruta, utilNeta, pct };
  };

  const cargar = async () => {
    setLoading(true);
    const [a, b] = await Promise.all([cargarMes(mesA), cargarMes(mesB)]);
    setDataA(a);
    setDataB(b);
    setLoading(false);
  };

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
    { label: "(-) CMV", a: dataA.cmv, b: dataB.cmv, tipo: "costo", big: false },
    { label: "(=) Utilidad Bruta", a: dataA.utilBruta, b: dataB.utilBruta, tipo: "util", big: true },
    { label: "(-) Gastos Fijos", a: dataA.gastosFijos, b: dataB.gastosFijos, tipo: "costo", big: false },
    { label: "(-) Gastos Variables", a: dataA.gastosVar, b: dataB.gastosVar, tipo: "costo", big: false },
    { label: "(-) Sueldos", a: dataA.sueldos, b: dataB.sueldos, tipo: "costo", big: false },
    { label: "(-) Publicidad", a: dataA.publicidad, b: dataB.publicidad, tipo: "costo", big: false },
    { label: "(=) Utilidad Neta", a: dataA.utilNeta, b: dataB.utilNeta, tipo: "util", big: true },
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
                  <tr key={fila.label} style={fila.big ? { background: "var(--s2)", fontWeight: 600 } : {}}>
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
