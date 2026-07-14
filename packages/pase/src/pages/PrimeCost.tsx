/* Prime Cost — CMV + Costo laboral (Operación).
 *
 * Prime Cost = Compras de mercadería (CMV) + Costo laboral (sueldos + cargas
 * sociales + boletas sindicales). Es el KPI #1 de gastronomía: el costo que el
 * dueño controla día a día. Benchmark típico sobre ventas:
 *   ≤60% verde · 60-65% amarillo · >65% rojo.
 *
 * Tres pestañas:
 *   - Resumen: prime cost total + sus dos componentes (CMV y Labor) con su %.
 *   - CMV: desglose por rubro con drill-down a cada compra (como Reportes).
 *   - Labor Cost: sueldos por empleado (drill-down a novedades) + cargas + boletas.
 *
 * Los datos salen de lib/primeCostData.ts, que replica el cálculo del EERR →
 * números idénticos a Reportes. El drill-down reusa EERRDetalleModal.
 *
 * BOCETO (al final): el cruce compras × stock × ventas por receta (control
 * cruzado del CMV) sigue pendiente; placeholder para no olvidarlo.
 */
import { useState, useEffect } from "react";
import { useCategorias } from "../lib/useCategorias";
import { InfoTooltip } from "../components/ui";
import { toISO, fmt_$ } from "@pase/shared/utils";
import { today } from "../lib/utils";
import EERRDetalleModal from "./EERRDetalleModal";
import { ordenarPorCategoria, buildSueldoBreakdown } from "./eerrDetalle";
import type { DetalleDescriptor, DetalleState } from "./eerrDetalle";
import { cargarPrimeCost, agruparLaborPorEmpleado } from "../lib/primeCostData";
import type { PrimeCostData } from "../lib/primeCostData";
import type { Usuario } from "../types/auth";

interface PrimeCostProps {
  user: Usuario;
  localActivo: number | null;
}

const CMV_DESCRIPTOR: DetalleDescriptor = { gastoTipo: null, facturaBucket: null, cmv: true };
type Tab = "resumen" | "cmv" | "labor";

// Benchmark del prime cost sobre ventas.
function benchmark(pct: number): { color: string; label: string } {
  if (pct <= 0) return { color: "var(--pase-text-muted)", label: "—" };
  if (pct <= 60) return { color: "#16a34a", label: "saludable" };
  if (pct <= 65) return { color: "#d97706", label: "atención" };
  return { color: "var(--danger)", label: "alto" };
}

export default function PrimeCost({ user, localActivo }: PrimeCostProps) {
  const { CATEGORIAS_COMPRA } = useCategorias();
  const [mes, setMes] = useState(toISO(today).slice(0, 7));
  const [data, setData] = useState<PrimeCostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("resumen");
  const [detalle, setDetalle] = useState<DetalleState | null>(null);

  useEffect(() => {
    let cancel = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag on re-fetch (mes/local), patrón estándar del repo.
    setLoading(true);
    cargarPrimeCost(user, localActivo, mes)
      .then(d => { if (!cancel) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [mes, localActivo, user]);

  const totalVentas = data?.totalVentas ?? 0;
  const pct = (n: number) => (totalVentas > 0 ? ((n / totalVentas) * 100).toFixed(1) + "%" : "—");
  const pctNum = (n: number) => (totalVentas > 0 ? (n / totalVentas) * 100 : 0);
  const primePct = pctNum(data?.primeCost ?? 0);
  const bm = benchmark(primePct);

  const porCatCMV = data
    ? ordenarPorCategoria(data.facturasCMV.map(f => ({ cat: f.cat, monto: Number(f.total || 0) })), CATEGORIAS_COMPRA)
    : [];
  const labor = data ? agruparLaborPorEmpleado(data) : { filas: [], restoSinAsignar: 0 };

  const abrirCat = (categoria: string) =>
    setDetalle({ tipo: "cat", titulo: categoria, descriptor: CMV_DESCRIPTOR, categoria });

  const tabs: { id: Tab; label: string }[] = [
    { id: "resumen", label: "Resumen" },
    { id: "cmv", label: "CMV" },
    { id: "labor", label: "Labor Cost" },
  ];

  return (
    <div>
      <div className="ph-row">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div className="ph-title">Prime Cost <span style={{ color: "var(--pase-text-muted)", fontWeight: 400 }}>· CMV + costo laboral</span></div>
          <InfoTooltip maxWidth={360}>
            <strong>Prime Cost</strong> = <strong>CMV</strong> (compras de mercadería) +
            <strong> costo laboral</strong> (sueldos + cargas sociales + boletas sindicales).
            Es el gasto que más controlás día a día. Como % de las ventas, el benchmark
            gastronómico es: <strong>≤60%</strong> saludable, <strong>60-65%</strong> atención,
            <strong> &gt;65%</strong> alto.
            <br /><br />
            Los números son los mismos que el Estado de Resultados (Reportes).
          </InfoTooltip>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="month" className="search" style={{ width: 160 }} value={mes} onChange={e => setMes(e.target.value)} />
        </div>
      </div>

      {/* Resumen prime cost — barra superior siempre visible */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-end", padding: "4px 2px" }}>
          <div className="kpi">
            <div className="kpi-label">Prime Cost {fmtMes(mes)}</div>
            <div className="kpi-value-compact" style={{ color: bm.color }}>{fmt_$(data?.primeCost ?? 0)}</div>
            <div className="kpi-sub" style={{ color: bm.color }}>
              {primePct > 0 ? primePct.toFixed(1) + "% de ventas · " + bm.label : "sin ventas"}
            </div>
          </div>
          <div className="kpi">
            <div className="kpi-label">CMV</div>
            <div className="kpi-value-compact">{fmt_$(data?.totalCMV ?? 0)}</div>
            <div className="kpi-sub">{pct(data?.totalCMV ?? 0)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Labor Cost</div>
            <div className="kpi-value-compact">{fmt_$(data?.laborCost ?? 0)}</div>
            <div className="kpi-sub">{pct(data?.laborCost ?? 0)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Ventas</div>
            <div className="kpi-value-compact">{fmt_$(totalVentas)}</div>
            <div className="kpi-sub">base del %</div>
          </div>
        </div>
        {/* Barra proporcional CMV vs Labor */}
        {totalVentas > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", height: 8, borderRadius: 999, overflow: "hidden", background: "var(--pase-surface)" }}>
              <div style={{ width: `${Math.min(pctNum(data?.totalCMV ?? 0), 100)}%`, background: "var(--pase-celeste)" }} title={`CMV ${pct(data?.totalCMV ?? 0)}`} />
              <div style={{ width: `${Math.min(pctNum(data?.laborCost ?? 0), 100)}%`, background: "#8b5cf6" }} title={`Labor ${pct(data?.laborCost ?? 0)}`} />
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 10, color: "var(--pase-text-muted)" }}>
              <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--pase-celeste)", marginRight: 4 }} />CMV {pct(data?.totalCMV ?? 0)}</span>
              <span><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#8b5cf6", marginRight: 4 }} />Labor {pct(data?.laborCost ?? 0)}</span>
              <span style={{ marginLeft: "auto" }}>Prime Cost {pct(data?.primeCost ?? 0)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Pestañas */}
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className="btn btn-sm"
            style={{
              fontSize: 12,
              background: tab === t.id ? "var(--pase-celeste)" : "transparent",
              color: tab === t.id ? "#fff" : "var(--pase-text-muted)",
              border: tab === t.id ? "none" : "0.5px solid var(--pase-border)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="panel"><div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 12 }}>Cargando…</div></div>
      ) : tab === "resumen" ? (
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">Composición del Prime Cost</span></div>
          <SummaryRow label="CMV — compras de mercadería" monto={data?.totalCMV ?? 0} pct={pct(data?.totalCMV ?? 0)} onClick={() => setTab("cmv")} />
          <SummaryRow label="Costo laboral" monto={data?.laborCost ?? 0} pct={pct(data?.laborCost ?? 0)} onClick={() => setTab("labor")} />
          <div style={{ paddingLeft: 16 }}>
            <SubRow label="Sueldos" monto={data?.sueldos ?? 0} pct={pct(data?.sueldos ?? 0)} />
            <SubRow label="Cargas sociales" monto={data?.cargasSociales ?? 0} pct={pct(data?.cargasSociales ?? 0)} />
            <SubRow label="Boletas sindicales" monto={data?.boletasSindicales ?? 0} pct={pct(data?.boletasSindicales ?? 0)} />
          </div>
          <div className="eerr-row" style={{ borderTop: "0.5px solid var(--pase-border-strong)", marginTop: 6, paddingTop: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: bm.color }}>PRIME COST</span>
            <div>
              <span className="num" style={{ fontWeight: 600, color: bm.color }}>{fmt_$(data?.primeCost ?? 0)}</span>
              <span style={{ fontSize: 10, color: bm.color, marginLeft: 6 }}>{pct(data?.primeCost ?? 0)}</span>
            </div>
          </div>
          <p style={{ fontSize: 11, color: "var(--pase-text-muted)", margin: "12px 2px 2px", lineHeight: 1.5 }}>
            Benchmark gastronómico sobre ventas: <strong style={{ color: "#16a34a" }}>≤60% saludable</strong> ·
            <strong style={{ color: "#d97706" }}> 60-65% atención</strong> ·
            <strong style={{ color: "var(--danger)" }}> &gt;65% alto</strong>.
            Este mes tu prime cost es <strong style={{ color: bm.color }}>{primePct > 0 ? primePct.toFixed(1) + "%" : "—"}</strong>.
          </p>
        </div>
      ) : tab === "cmv" ? (
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">MERCADERÍA (CMV) por rubro</span></div>
          {porCatCMV.length === 0 ? (
            <div style={{ height: 100, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted2)", fontSize: 12 }}>
              No hay compras de mercadería cargadas en este mes.
            </div>
          ) : (
            <>
              <div className="eerr-section-title" style={{ cursor: "default" }}>
                Total — <span style={{ color: "var(--pase-text)" }}>{fmt_$(data?.totalCMV ?? 0)}</span> <span style={{ color: "var(--muted)" }}>{pct(data?.totalCMV ?? 0)}</span>
              </div>
              {porCatCMV.map(x => (
                <div key={x.c} className="eerr-row" onClick={() => abrirCat(x.c)} style={{ cursor: "pointer" }} title="Ver compras de este rubro">
                  <span style={{ fontSize: 11, color: "var(--muted2)" }}>{x.c}<span style={{ fontSize: 9, color: "var(--muted)", marginLeft: 5 }}>›</span></span>
                  <div><span className="num" style={{ color: "var(--pase-text)" }}>{fmt_$(x.t)}</span><span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6 }}>{pct(x.t)}</span></div>
                </div>
              ))}
            </>
          )}
        </div>
      ) : (
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">COSTO LABORAL por empleado</span></div>
          <div className="eerr-section-title" style={{ cursor: "default" }}>
            Total — <span style={{ color: "var(--pase-text)" }}>{fmt_$(data?.laborCost ?? 0)}</span> <span style={{ color: "var(--muted)" }}>{pct(data?.laborCost ?? 0)}</span>
          </div>
          {(data?.cargasSociales ?? 0) > 0.5 && (
            <div className="eerr-row"><span style={{ fontSize: 11, color: "var(--muted2)" }}>Cargas sociales</span><div><span className="num" style={{ color: "var(--pase-text)" }}>{fmt_$(data!.cargasSociales)}</span><span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6 }}>{pct(data!.cargasSociales)}</span></div></div>
          )}
          {(data?.boletasSindicales ?? 0) > 0.5 && (
            <div className="eerr-row"><span style={{ fontSize: 11, color: "var(--muted2)" }}>Boletas sindicales</span><div><span className="num" style={{ color: "var(--pase-text)" }}>{fmt_$(data!.boletasSindicales)}</span><span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6 }}>{pct(data!.boletasSindicales)}</span></div></div>
          )}
          {labor.filas.length === 0 && labor.restoSinAsignar <= 0.5 && (data?.especialesSueldos ?? 0) <= 0.5 && (data?.cargasSociales ?? 0) <= 0.5 && (data?.boletasSindicales ?? 0) <= 0.5 ? (
            <div className="eerr-row"><span style={{ fontSize: 11, color: "var(--muted2)" }}>Sin sueldos pagados este mes</span></div>
          ) : (
            <>
              {labor.filas.map(({ emp, total, liqs, ade }) => (
                <div
                  key={emp.apellido + emp.nombre}
                  className="eerr-row"
                  onClick={() => setDetalle({ tipo: "sueldo", titulo: `${emp.apellido}, ${emp.nombre}`, subtitulo: emp.puesto || "", breakdown: buildSueldoBreakdown(liqs, ade), total })}
                  style={{ cursor: "pointer" }}
                  title="Ver resumen de novedades"
                >
                  <span style={{ fontSize: 11, color: "var(--muted2)" }}>
                    {emp.apellido}, {emp.nombre}
                    <span style={{ fontSize: 9, color: "var(--muted)", marginLeft: 6 }}>{emp.puesto}</span>
                    <span style={{ fontSize: 9, color: "var(--muted)", marginLeft: 5 }}>›</span>
                  </span>
                  <div><span className="num" style={{ color: "var(--pase-text)" }}>{fmt_$(total)}</span><span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6 }}>{pct(total)}</span></div>
                </div>
              ))}
              {labor.restoSinAsignar > 0.5 && (
                <div className="eerr-row"><span style={{ fontSize: 11, color: "var(--muted2)" }}>Mano de obra / otros<span style={{ fontSize: 9, color: "var(--muted)", marginLeft: 6 }}>sin empleado asignado</span></span><div><span className="num" style={{ color: "var(--pase-text)" }}>{fmt_$(labor.restoSinAsignar)}</span><span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6 }}>{pct(labor.restoSinAsignar)}</span></div></div>
              )}
            </>
          )}
        </div>
      )}

      {/* BOCETO: cruce compras × stock × ventas por receta (control cruzado del CMV). */}
      <BocetoControlCMV />

      {detalle && (
        <EERRDetalleModal state={detalle} mes={mes} localActivo={localActivo} user={user} onClose={() => setDetalle(null)} />
      )}
    </div>
  );
}

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function fmtMes(mes: string): string {
  const [yr, mo] = mes.split("-").map(Number) as [number, number];
  return `${MESES[mo - 1]} ${String(yr).slice(2)}`;
}

function SummaryRow({ label, monto, pct, onClick }: { label: string; monto: number; pct: string; onClick: () => void }) {
  return (
    <div className="eerr-row" onClick={onClick} style={{ cursor: "pointer" }} title="Ver detalle">
      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--pase-text)" }}>{label}<span style={{ fontSize: 9, color: "var(--muted)", marginLeft: 5 }}>›</span></span>
      <div><span className="num" style={{ fontWeight: 500, color: "var(--pase-text)" }}>{fmt_$(monto)}</span><span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6 }}>{pct}</span></div>
    </div>
  );
}

function SubRow({ label, monto, pct }: { label: string; monto: number; pct: string }) {
  return (
    <div className="eerr-row">
      <span style={{ fontSize: 11, color: "var(--muted2)" }}>{label}</span>
      <div><span className="num" style={{ color: "var(--muted)" }}>{fmt_$(monto)}</span><span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6 }}>{pct}</span></div>
    </div>
  );
}

/* Boceto de la etapa siguiente: control cruzado del CMV (compras × stock × ventas
 * por receta). Puramente informativo — todavía NO construido. */
function BocetoControlCMV() {
  const cruces = [
    { t: "CMV real vs teórico", d: "Comparar lo que costó la mercadería según compras/stock contra lo que las ventas deberían haber costado según receta. Desvío grande = merma, robo, receta mal cargada o precio viejo." },
    { t: "Insumos consumidos vs stock", d: "El consumo teórico (ventas × receta) tiene que coincidir con las salidas de stock. Si no cuadra, hay faltantes sin registrar o cargas de stock incompletas." },
  ];
  return (
    <div className="panel" style={{ marginTop: 16, border: "1px dashed var(--pase-border-strong)", background: "color-mix(in srgb, var(--pase-accent) 4%, transparent)" }}>
      <div className="panel-hd" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="panel-title">Control cruzado del CMV</span>
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.04em", color: "var(--pase-accent)", border: "1px solid color-mix(in srgb, var(--pase-accent) 40%, transparent)", borderRadius: 999, padding: "1px 8px" }}>PRÓXIMAMENTE</span>
      </div>
      <p style={{ fontSize: 12, color: "var(--pase-text-muted)", margin: "4px 2px 14px", lineHeight: 1.5, maxWidth: "72ch" }}>
        Próxima etapa: cruzar <strong>compras × stock × ventas por receta</strong> para que el CMV cierre contra lo que se vendió. Todavía no está construido — esto queda como plano.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {cruces.map((c, i) => (
          <div key={c.t} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, color: "var(--pase-accent)", background: "color-mix(in srgb, var(--pase-accent) 12%, transparent)" }}>{i + 1}</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--pase-text)" }}>{c.t}</div>
              <div style={{ fontSize: 11, color: "var(--pase-text-muted)", lineHeight: 1.5, maxWidth: "72ch" }}>{c.d}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
