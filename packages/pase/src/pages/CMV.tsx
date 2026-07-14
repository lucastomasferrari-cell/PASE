/* CMV — Costo de Mercadería Vendida (Operación).
 *
 * Vista dedicada al bloque MERCADERÍA (CMV) que también vive en Reportes/EERR,
 * extraída acá para tenerlo a mano en Operación con el mismo drill-down:
 *   rubro (categoría de compra) → todas las compras de esa categoría (modal)
 *   → tocar una compra → salta a esa factura en /compras.
 *
 * Reusa las mismas piezas que el EERR para que los números den IDÉNTICOS:
 *   - facturas del mes con bucket NULL (legacy) o 'cat_compra' = CMV.
 *   - ordenarPorCategoria() para el desglose por categoría.
 *   - EERRDetalleModal (modo "cat") para el drill-down + navegación al origen.
 *   - pct = share sobre las ventas del mes (igual que en Reportes).
 *
 * BOCETO (sección "Próximamente" al final): el cruce compras × stock × ventas
 * por receta todavía NO está construido — es un placeholder para no olvidarlo.
 */
import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope } from "../lib/auth";
import { useCategorias } from "../lib/useCategorias";
import { InfoTooltip } from "../components/ui";
import { toISO, fmt_$ } from "@pase/shared/utils";
import { today } from "../lib/utils";
import EERRDetalleModal from "./EERRDetalleModal";
import { ordenarPorCategoria } from "./eerrDetalle";
import type { DetalleDescriptor, DetalleState } from "./eerrDetalle";
import type { Usuario } from "../types/auth";
import type { Factura, Venta } from "../types/finanzas";

interface CMVProps {
  user: Usuario;
  localActivo: number | null;
}

// Descriptor CMV para el modal de detalle: facturas con bucket NULL o
// 'cat_compra' (mismo criterio que DETALLE_SECCIONES.cmv del EERR).
const CMV_DESCRIPTOR: DetalleDescriptor = { gastoTipo: null, facturaBucket: null, cmv: true };

export default function CMV({ user, localActivo }: CMVProps) {
  const { CATEGORIAS_COMPRA } = useCategorias();
  const [mes, setMes] = useState(toISO(today).slice(0, 7));
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [totalVentas, setTotalVentas] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detalle, setDetalle] = useState<DetalleState | null>(null);

  useEffect(() => {
    let cancel = false;
    const load = async () => {
      setLoading(true);
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

      const [{ data: v }, { data: f }] = await Promise.all([vq, fq]);
      if (cancel) return;
      setTotalVentas(((v as Venta[]) || []).reduce((s, x) => s + (x.monto || 0), 0));
      setFacturas((f as Factura[]) || []);
      setLoading(false);
    };
    load();
    return () => { cancel = true; };
  }, [mes, localActivo, user]);

  // CMV = facturas con bucket NULL (legacy) o 'cat_compra'. Las facturas con
  // bucket='gasto_*' son gastos operativos, NO CMV (no inflan el costo de mercadería).
  const facturasCMV = [...facturas.filter(f => !f.bucket), ...facturas.filter(f => f.bucket === "cat_compra")];
  const totalCMV = facturasCMV.reduce((s, f) => s + (Number(f.total) || 0), 0);
  const porCatCMV = ordenarPorCategoria(
    facturasCMV.map(f => ({ cat: f.cat, monto: Number(f.total || 0) })),
    CATEGORIAS_COMPRA,
  );
  const pct = (n: number) => (totalVentas > 0 ? ((n / totalVentas) * 100).toFixed(1) + "%" : "—");

  const abrirCat = (categoria: string) =>
    setDetalle({ tipo: "cat", titulo: categoria, descriptor: CMV_DESCRIPTOR, categoria });

  return (
    <div>
      <div className="ph-row">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div className="ph-title">CMV <span style={{ color: "var(--pase-text-muted)", fontWeight: 400 }}>· Costo de Mercadería</span></div>
          <InfoTooltip maxWidth={340}>
            <strong>CMV</strong> (Costo de Mercadería Vendida) es lo que gastaste en insumos
            para producir. Se arma con las <strong>compras</strong> (facturas de proveedores)
            del mes, agrupadas por rubro. Tocá un rubro para ver sus compras, y una compra para
            abrirla. El % es sobre las ventas del mes.
            <br /><br />
            <em>Próximamente:</em> cruce contra stock y ventas por receta para validar el CMV.
          </InfoTooltip>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="month" className="search" style={{ width: 160 }} value={mes} onChange={e => setMes(e.target.value)} />
        </div>
      </div>

      {/* Resumen */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", padding: "4px 2px" }}>
          <div className="kpi">
            <div className="kpi-label">CMV del mes</div>
            <div className="kpi-value-compact kpi-warn">{fmt_$(totalCMV)}</div>
            <div className="kpi-sub">{pct(totalCMV)} de ventas</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Ventas del mes</div>
            <div className="kpi-value-compact">{fmt_$(totalVentas)}</div>
            <div className="kpi-sub">base del %</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Compras cargadas</div>
            <div className="kpi-value-compact">{facturasCMV.length}</div>
            <div className="kpi-sub">{porCatCMV.length} rubro{porCatCMV.length === 1 ? "" : "s"}</div>
          </div>
        </div>
      </div>

      {/* Desglose por rubro (mismo drill-down que Reportes) */}
      <div className="panel">
        <div className="panel-hd"><span className="panel-title">MERCADERÍA (CMV) por rubro</span></div>
        {loading ? (
          <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 12 }}>
            Cargando…
          </div>
        ) : porCatCMV.length === 0 ? (
          <div style={{ height: 100, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted2)", fontSize: 12 }}>
            No hay compras de mercadería cargadas en este mes.
          </div>
        ) : (
          <>
            <div className="eerr-section-title" style={{ cursor: "default" }}>
              Total — <span style={{ color: "var(--pase-text)" }}>{fmt_$(totalCMV)}</span> <span style={{ color: "var(--muted)" }}>{pct(totalCMV)}</span>
            </div>
            {porCatCMV.map(x => (
              <div
                key={x.c}
                className="eerr-row"
                onClick={() => abrirCat(x.c)}
                style={{ cursor: "pointer" }}
                title="Ver compras de este rubro"
              >
                <span style={{ fontSize: 11, color: "var(--muted2)" }}>
                  {x.c}<span style={{ fontSize: 9, color: "var(--muted)", marginLeft: 5 }}>›</span>
                </span>
                <div>
                  <span className="num" style={{ color: "var(--pase-text)" }}>{fmt_$(x.t)}</span>
                  <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6 }}>{pct(x.t)}</span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* ───────────── BOCETO: cruce compras × stock × ventas por receta ─────────────
          Placeholder de la próxima etapa. NO está construido: sirve de recordatorio
          de qué vamos a desarrollar y cómo se cruza la info. */}
      <BocetoControlCMV />

      {detalle && (
        <EERRDetalleModal
          state={detalle}
          mes={mes}
          localActivo={localActivo}
          user={user}
          onClose={() => setDetalle(null)}
        />
      )}
    </div>
  );
}

/* Boceto de la etapa siguiente: control cruzado del CMV. Puramente informativo. */
function BocetoControlCMV() {
  const fuentes = [
    { t: "Compras", d: "lo que entró (facturas de proveedores por rubro/insumo)" },
    { t: "Stock", d: "movimientos de inventario: entradas, salidas y ajustes/mermas" },
    { t: "Ventas × Receta", d: "cada venta explota su receta → insumos que debería haber consumido" },
  ];
  const cruces = [
    {
      t: "CMV real vs CMV teórico",
      d: "Comparar lo que costó la mercadería según compras/stock contra lo que las ventas deberían haber costado según receta. Un desvío grande = merma, robo, receta mal cargada, o precio desactualizado.",
    },
    {
      t: "Insumos consumidos vs stock",
      d: "El consumo teórico (ventas × receta) tiene que coincidir con las salidas de stock. Si no cuadra, hay faltantes sin registrar o cargas de stock incompletas.",
    },
  ];
  return (
    <div
      className="panel"
      style={{
        marginTop: 16,
        border: "1px dashed var(--pase-border-strong)",
        background: "color-mix(in srgb, var(--pase-accent) 4%, transparent)",
      }}
    >
      <div className="panel-hd" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="panel-title">Control cruzado del CMV</span>
        <span
          style={{
            fontSize: 10, fontWeight: 600, letterSpacing: "0.04em",
            color: "var(--pase-accent)",
            border: "1px solid color-mix(in srgb, var(--pase-accent) 40%, transparent)",
            borderRadius: 999, padding: "1px 8px",
          }}
        >
          PRÓXIMAMENTE
        </span>
      </div>

      <p style={{ fontSize: 12, color: "var(--pase-text-muted)", margin: "4px 2px 14px", lineHeight: 1.5, maxWidth: "72ch" }}>
        Boceto de la próxima etapa. La idea es cruzar tres fuentes de datos para que el
        CMV no sea sólo "lo que compré", sino que <strong>cierre</strong> contra lo que se
        vendió y lo que hay en stock. Todavía no está construido — esto queda como plano.
      </p>

      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginBottom: 16 }}>
        {fuentes.map(f => (
          <div key={f.t} style={{ padding: "10px 12px", border: "0.5px solid var(--pase-border)", borderRadius: 10, background: "var(--pase-surface)" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--pase-text)", marginBottom: 3 }}>{f.t}</div>
            <div style={{ fontSize: 11, color: "var(--pase-text-muted)", lineHeight: 1.45 }}>{f.d}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {cruces.map((c, i) => (
          <div key={c.t} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span
              style={{
                flexShrink: 0, width: 22, height: 22, borderRadius: 7,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontWeight: 600,
                color: "var(--pase-accent)",
                background: "color-mix(in srgb, var(--pase-accent) 12%, transparent)",
              }}
            >
              {i + 1}
            </span>
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
