// Simulador de escenarios del EERR (sub-vista de Reportes). Recibe la base ya
// computada por EERR.tsx, deja editar cada línea ($ o %) y muestra Real vs
// Simulado en vivo. NO hace fetch, NO escribe nada, NO guarda. La matemática
// vive en lib/eerrSimulador.ts.
import { Fragment, useMemo, useState } from "react";
import { fmt_$ } from "../lib/utils";
import { simularEERR, type LineasEERR, type AjusteLinea } from "../lib/eerrSimulador";

interface Props {
  base: LineasEERR;
  mes: string;            // "YYYY-MM"
  onClose: () => void;
}

type Unidad = "abs" | "pct";
interface InputLinea { unidad: Unidad; texto: string }

const LINEAS: { key: keyof LineasEERR; label: string }[] = [
  { key: "ventas", label: "Ventas Brutas" },
  { key: "cmv", label: "Compras de mercadería" },
  { key: "gastosFijos", label: "Gastos Fijos" },
  { key: "gastosVar", label: "Gastos Variables" },
  { key: "sueldos", label: "Sueldos" },
  { key: "cargasSociales", label: "Cargas Sociales" },
  { key: "publicidad", label: "Publicidad y MKT" },
  { key: "comisiones", label: "Comisiones" },
  { key: "impuestos", label: "Impuestos" },
  { key: "otrosGastos", label: "Otros Gastos" },
];

const pctTxt = (n: number, ventas: number) => (ventas > 0 ? ((n / ventas) * 100).toFixed(1) + "%" : "—");

export default function EERRSimulador({ base, mes, onClose }: Props) {
  const [inputs, setInputs] = useState<Partial<Record<keyof LineasEERR, InputLinea>>>({});

  const ajustes = useMemo(() => {
    const out: Partial<Record<keyof LineasEERR, AjusteLinea>> = {};
    (Object.keys(inputs) as (keyof LineasEERR)[]).forEach((k) => {
      const inp = inputs[k];
      if (!inp || inp.texto.trim() === "") return;
      const valor = Number(inp.texto);
      if (Number.isNaN(valor)) return;
      out[k] = { tipo: inp.unidad, valor };
    });
    return out;
  }, [inputs]);

  const real = useMemo(() => simularEERR(base, {}), [base]);
  const sim = useMemo(() => simularEERR(base, ajustes), [base, ajustes]);
  const deltaNeta = sim.utilNeta - real.utilNeta;

  const setLinea = (k: keyof LineasEERR, patch: Partial<InputLinea>) =>
    setInputs((prev) => ({
      ...prev,
      [k]: { unidad: prev[k]?.unidad ?? "pct", texto: prev[k]?.texto ?? "", ...patch },
    }));

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontWeight: 500 }}>Simulador de escenario · {mes}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setInputs({})}>Reset</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Salir del simulador</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
        <Kpi label="Utilidad Neta — Real" value={fmt_$(real.utilNeta)} sub={pctTxt(real.utilNeta, real.lineas.ventas)} />
        <Kpi label="Utilidad Neta — Simulada" value={fmt_$(sim.utilNeta)} sub={pctTxt(sim.utilNeta, sim.lineas.ventas)}
          color={sim.utilNeta >= real.utilNeta ? "var(--pase-celeste)" : "#B91C1C"} />
        <Kpi label="Diferencia" value={(deltaNeta >= 0 ? "+" : "") + fmt_$(deltaNeta)}
          color={deltaNeta >= 0 ? "var(--pase-celeste)" : "#B91C1C"} />
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ color: "var(--pase-text-muted)", fontSize: 11, textAlign: "left" }}>
              <th style={th}>Línea</th>
              <th style={{ ...th, textAlign: "right" }}>Real</th>
              <th style={{ ...th, textAlign: "center" }}>Ajuste</th>
              <th style={{ ...th, textAlign: "right" }}>Simulado</th>
            </tr>
          </thead>
          <tbody>
            {LINEAS.map(({ key, label }) => {
              const inp = inputs[key];
              const realV = real.lineas[key];
              const simV = sim.lineas[key];
              return (
                <Fragment key={key}>
                  <tr style={{ borderTop: "0.5px solid var(--pase-border)" }}>
                    <td style={td}>{label}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {fmt_$(realV)} <span style={muted}>{pctTxt(realV, real.lineas.ventas)}</span>
                    </td>
                    <td style={{ ...td, textAlign: "center", whiteSpace: "nowrap" }}>
                      <select value={inp?.unidad ?? "pct"} onChange={(e) => setLinea(key, { unidad: e.target.value as Unidad })} style={sel}>
                        <option value="pct">%</option>
                        <option value="abs">$</option>
                      </select>
                      <input value={inp?.texto ?? ""} onChange={(e) => setLinea(key, { texto: e.target.value })}
                        inputMode="decimal" placeholder={(inp?.unidad ?? "pct") === "abs" ? "$ nuevo" : "% ej. -10"}
                        style={inputStyle} />
                    </td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: simV !== realV ? 600 : 400 }}>
                      {fmt_$(simV)} <span style={muted}>{pctTxt(simV, sim.lineas.ventas)}</span>
                    </td>
                  </tr>
                  {key === "cmv" && (
                    <SubtotalRow label="Utilidad Bruta" real={real.utilBruta} sim={sim.utilBruta}
                      ventasReal={real.lineas.ventas} ventasSim={sim.lineas.ventas} />
                  )}
                </Fragment>
              );
            })}
            <SubtotalRow label="Utilidad Neta" real={real.utilNeta} sim={sim.utilNeta}
              ventasReal={real.lineas.ventas} ventasSim={sim.lineas.ventas} big />
          </tbody>
        </table>
      </div>

      <div style={{ ...muted, marginTop: 10 }}>
        Simulación en vivo — no modifica ningún dato real ni se guarda. El ajuste en % es relativo al valor real
        (ej. −10 baja un 10%); en $ reemplaza el monto. Las líneas son independientes.
      </div>
    </div>
  );
}

function SubtotalRow({ label, real, sim, ventasReal, ventasSim, big }: {
  label: string; real: number; sim: number; ventasReal: number; ventasSim: number; big?: boolean;
}) {
  return (
    <tr style={{ borderTop: big ? "1.5px solid var(--pase-border)" : "1px solid var(--pase-border)", fontWeight: 500 }}>
      <td style={td}>{label}</td>
      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt_$(real)} <span style={muted}>{pctTxt(real, ventasReal)}</span></td>
      <td style={td}></td>
      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: sim >= real ? "var(--pase-celeste)" : "#B91C1C" }}>{fmt_$(sim)} <span style={muted}>{pctTxt(sim, ventasSim)}</span></td>
    </tr>
  );
}

function Kpi({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ minWidth: 160 }}>
      <div style={{ fontSize: 11, color: "var(--pase-text-muted)" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 500, fontVariantNumeric: "tabular-nums", color: color ?? "var(--pase-text)" }}>{value}</div>
      {sub && <div style={muted}>{sub}</div>}
    </div>
  );
}

const card: React.CSSProperties = { border: "0.5px solid var(--pase-border)", borderRadius: 10, padding: 16, background: "var(--pase-surface)", marginTop: 12 };
const th: React.CSSProperties = { padding: "4px 8px", fontWeight: 400 };
const td: React.CSSProperties = { padding: "5px 8px" };
const muted: React.CSSProperties = { fontSize: 10, color: "var(--pase-text-muted)" };
const sel: React.CSSProperties = { padding: "2px 4px", borderRadius: 6, border: "0.5px solid var(--pase-border)", background: "var(--pase-surface)", color: "var(--pase-text)", marginRight: 4 };
const inputStyle: React.CSSProperties = { padding: "3px 6px", borderRadius: 6, border: "0.5px solid var(--pase-border)", background: "var(--pase-surface)", color: "var(--pase-text)", textAlign: "right", width: 100 };
