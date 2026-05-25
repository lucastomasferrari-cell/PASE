// Tab CMV: Teórico vs Real + Eficiencia
//
// Llama a las RPCs creadas en migration 202605211500_cmv_real.sql:
//   - fn_cmv_real_resumen(tenant, local, desde, hasta) → KPIs globales
//   - fn_cmv_real(tenant, local, desde, hasta) → detalle por insumo
//
// El Teórico ya se calcula desde fn_reporte_cmv (movimientos salida_venta).
// Esta pantalla cruza Real y Teórico y muestra la diferencia.

import { useState, useEffect, useMemo } from "react";
import { db } from "../../lib/supabase";
import { fmt_$, toISO, today } from "../../lib/utils";
import { EmptyState } from "../../components/ui";
import type { Usuario, Local } from "../../types";

interface Props {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

interface ResumenCMV {
  consumo_real_valor: number;
  consumo_teorico_valor: number;
  compras_valor: number;
  mermas_valor: number;
  diferencia_valor: number;
  eficiencia_pct: number | null;
  insumos_con_fuga: number;
  facturacion: number;
  cmv_real_pct: number | null;
  cmv_teorico_pct: number | null;
}

interface DetalleInsumo {
  insumo_id: number;
  insumo_nombre: string;
  unidad: string;
  stock_inicial: number;
  compras_cantidad: number;
  compras_valor: number;
  mermas_cantidad: number;
  mermas_valor: number;
  stock_final: number;
  consumo_real_cantidad: number;
  consumo_real_valor: number;
  consumo_teorico_cantidad: number;
  consumo_teorico_valor: number;
  diferencia_cantidad: number;
  diferencia_valor: number;
  eficiencia_pct: number | null;
}

export function TabCMV({ user, locales, localActivo }: Props) {
  // Default: este mes
  const [desde, setDesde] = useState(() => {
    const d = new Date(today.getFullYear(), today.getMonth(), 1);
    return toISO(d);
  });
  const [hasta, setHasta] = useState(toISO(today));
  const [localFiltro, setLocalFiltro] = useState<number | null>(localActivo);
  const [resumen, setResumen] = useState<ResumenCMV | null>(null);
  const [detalle, setDetalle] = useState<DetalleInsumo[]>([]);
  const [loading, setLoading] = useState(false);

  // Gastro-Sensei IA: análisis automático del CMV con sugerencias accionables.
  // Llama a /api/claude task=gastro-sensei con resumen + top insumos.
  // Spec original del dueño: "Tu CMV de Salmón subió un 4% pero tus ventas no.
  // El encargado de Palermo está porcionando de más o hay una fuga en la
  // recepción de mercadería".
  const [senseiOpen, setSenseiOpen] = useState(false);
  const [senseiLoading, setSenseiLoading] = useState(false);
  const [senseiText, setSenseiText] = useState<string | null>(null);
  const [senseiError, setSenseiError] = useState<string | null>(null);

  const tenantId = user.tenant_id;

  useEffect(() => {
    if (!tenantId || !localFiltro) return;
    (async () => {
      setLoading(true);
      const [resRes, detRes] = await Promise.all([
        db.rpc("fn_cmv_real_resumen", {
          p_tenant_id: tenantId,
          p_local_id: localFiltro,
          p_desde: desde,
          p_hasta: hasta,
        }),
        db.rpc("fn_cmv_real", {
          p_tenant_id: tenantId,
          p_local_id: localFiltro,
          p_desde: desde,
          p_hasta: hasta,
        }),
      ]);
      if (resRes.data && resRes.data.length > 0) {
        setResumen(resRes.data[0] as ResumenCMV);
      } else {
        setResumen(null);
      }
      setDetalle((detRes.data as DetalleInsumo[]) || []);
      setLoading(false);
    })();
  }, [tenantId, localFiltro, desde, hasta]);

  const locsDisp = useMemo(() => {
    if (user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin") return locales;
    return locales.filter(l => (user._locales || user.locales || []).includes(l.id));
  }, [locales, user]);

  // Auto-set local si no había
  useEffect(() => {
    if (localFiltro == null && locsDisp.length > 0) {
      setLocalFiltro(locsDisp[0]!.id);
    }
  }, [localFiltro, locsDisp]);

  const eficienciaColor = (pct: number | null) => {
    if (pct == null) return "var(--muted2)";
    if (pct >= 95) return "var(--success)";
    if (pct >= 80) return "var(--warn)";
    return "var(--danger)";
  };

  const eficienciaLabel = (pct: number | null) => {
    if (pct == null) return "Sin datos";
    if (pct >= 95) return "Excelente";
    if (pct >= 85) return "Bueno";
    if (pct >= 70) return "Atención";
    return "Crítico";
  };

  return (
    <div>
      {/* ─── Filtros ─── */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-hd" style={{ flexWrap: "wrap", gap: 8 }}>
          <span className="panel-title">Período</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="date" className="search" style={{ width: 140 }} value={desde} onChange={e => setDesde(e.target.value)} />
            <span style={{ color: "var(--muted2)" }}>→</span>
            <input type="date" className="search" style={{ width: 140 }} value={hasta} onChange={e => setHasta(e.target.value)} />
            <select className="search" style={{ width: 200 }} value={localFiltro ?? ""} onChange={e => setLocalFiltro(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Seleccioná local...</option>
              {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
        </div>
      </div>

      {!localFiltro ? (
        <EmptyState
          icon="📊"
          title="Elegí un local"
          description="El CMV se calcula por local. Seleccioná uno arriba."
        />
      ) : loading ? (
        <div className="loading">Calculando CMV...</div>
      ) : !resumen || (resumen.consumo_real_valor === 0 && resumen.consumo_teorico_valor === 0) ? (
        <EmptyState
          icon="📦"
          title="Sin datos en este período"
          description="No hay movimientos de stock (ventas + compras) para calcular CMV. Probá ampliar el rango de fechas o cargá facturas con materia prima vinculada."
        />
      ) : (
        <>
          {/* ─── KPIs principales ─── */}
          <div className="grid3" style={{ marginBottom: 16 }}>
            <div className="kpi">
              <div className="kpi-label">CMV Teórico</div>
              <div className="kpi-value" style={{ fontSize: 22 }}>{fmt_$(resumen.consumo_teorico_valor)}</div>
              <div className="kpi-sub">
                {resumen.cmv_teorico_pct != null ? `${resumen.cmv_teorico_pct}% sobre ventas` : "lo que dicen las recetas"}
              </div>
            </div>
            <div className="kpi">
              <div className="kpi-label">CMV Real</div>
              <div className="kpi-value" style={{ fontSize: 22 }}>{fmt_$(resumen.consumo_real_valor)}</div>
              <div className="kpi-sub">
                {resumen.cmv_real_pct != null ? `${resumen.cmv_real_pct}% sobre ventas` : "lo que realmente se consumió"}
              </div>
            </div>
            <div className="kpi" style={{ background: resumen.eficiencia_pct != null && resumen.eficiencia_pct < 80 ? "rgba(220,38,38,0.06)" : undefined }}>
              <div className="kpi-label">Eficiencia</div>
              <div className="kpi-value" style={{ fontSize: 22, color: eficienciaColor(resumen.eficiencia_pct) }}>
                {resumen.eficiencia_pct != null ? `${resumen.eficiencia_pct}%` : "—"}
              </div>
              <div className="kpi-sub">{eficienciaLabel(resumen.eficiencia_pct)}</div>
            </div>
          </div>

          {/* ─── KPIs secundarios ─── */}
          <div className="grid3" style={{ marginBottom: 16 }}>
            <div className="kpi">
              <div className="kpi-label">Compras del período</div>
              <div className="kpi-value" style={{ fontSize: 18 }}>{fmt_$(resumen.compras_valor)}</div>
              <div className="kpi-sub">facturas con MP vinculada</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Mermas declaradas</div>
              <div className="kpi-value" style={{ fontSize: 18, color: "var(--warn)" }}>{fmt_$(resumen.mermas_valor)}</div>
              <div className="kpi-sub">en el período</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Insumos con fuga</div>
              <div className="kpi-value" style={{ fontSize: 18, color: resumen.insumos_con_fuga > 0 ? "var(--danger)" : "var(--success)" }}>
                {resumen.insumos_con_fuga}
              </div>
              <div className="kpi-sub">diferencia &gt;5% sin justificar</div>
            </div>
          </div>

          {/* ─── Explicación de la diferencia ─── */}
          {resumen.diferencia_valor !== 0 && (
            <div
              style={{
                padding: "12px 16px",
                background: resumen.diferencia_valor < 0 ? "rgba(220,38,38,0.08)" : "rgba(34,197,94,0.08)",
                border: `1px solid ${resumen.diferencia_valor < 0 ? "rgba(220,38,38,0.3)" : "rgba(34,197,94,0.3)"}`,
                borderRadius: 8,
                marginBottom: 16,
                fontSize: 13,
              }}
            >
              {resumen.diferencia_valor < 0 ? (
                <>
                  <strong style={{ color: "var(--danger)" }}>Pérdida no explicada: {fmt_$(Math.abs(resumen.diferencia_valor))}</strong>
                  <div style={{ marginTop: 4, color: "var(--muted2)", fontSize: 11 }}>
                    El consumo real es mayor que lo que las recetas dicen que se debería haber consumido.
                    Posibles causas: porcionado de más, fugas no declaradas, error en la receta, robos.
                  </div>
                </>
              ) : (
                <>
                  <strong style={{ color: "var(--success)" }}>Ahorro vs receta: {fmt_$(resumen.diferencia_valor)}</strong>
                  <div style={{ marginTop: 4, color: "var(--muted2)", fontSize: 11 }}>
                    Se consumió menos que lo que dicen las recetas. Buena gestión de cocina o porciones más chicas.
                  </div>
                </>
              )}
            </div>
          )}

          {/* ─── Gastro-Sensei IA ─── */}
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-hd" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="panel-title">🤖 Gastro-Sensei (análisis IA)</span>
              {!senseiOpen ? (
                <button
                  className="btn btn-acc btn-sm"
                  onClick={async () => {
                    setSenseiOpen(true);
                    setSenseiLoading(true);
                    setSenseiError(null);
                    setSenseiText(null);
                    try {
                      const { data: sess } = await db.auth.getSession();
                      const token = sess.session?.access_token;
                      if (!token) throw new Error("Sesión expirada. Refrescá.");
                      // Top 10 insumos con mayor magnitud de diferencia
                      const topInsumos = [...detalle]
                        .sort((a, b) => Math.abs(Number(b.diferencia_valor)) - Math.abs(Number(a.diferencia_valor)))
                        .slice(0, 10);
                      const localNombre = locales.find(l => l.id === localFiltro)?.nombre;
                      const resp = await fetch("/api/claude", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                        body: JSON.stringify({
                          task: "gastro-sensei",
                          cmv_resumen: resumen,
                          top_insumos: topInsumos,
                          periodo: { desde, hasta },
                          contexto: { local_nombre: localNombre },
                        }),
                      });
                      const json = await resp.json();
                      if (!resp.ok) throw new Error(json?.error?.message || `HTTP ${resp.status}`);
                      const text = json.content?.[0]?.text || "(Respuesta vacía)";
                      setSenseiText(text);
                    } catch (e) {
                      setSenseiError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setSenseiLoading(false);
                    }
                  }}
                  disabled={!resumen || detalle.length === 0}
                  title={!resumen || detalle.length === 0 ? "Cargá un período con datos primero" : "Analizar este CMV con IA"}
                >
                  Analizar mi CMV
                </button>
              ) : (
                <button className="btn btn-ghost btn-sm" onClick={() => { setSenseiOpen(false); setSenseiText(null); setSenseiError(null); }}>
                  Cerrar
                </button>
              )}
            </div>
            {senseiOpen && (
              <div style={{ padding: "14px 16px" }}>
                {senseiLoading ? (
                  <div style={{ color: "var(--muted2)", fontSize: 13 }}>
                    Analizando tus números… <span style={{ animation: "pulse 1.5s ease-in-out infinite" }}>🤔</span>
                  </div>
                ) : senseiError ? (
                  <div style={{ color: "var(--danger)", fontSize: 13 }}>
                    Error: {senseiError}
                  </div>
                ) : senseiText ? (
                  <div style={{
                    whiteSpace: "pre-wrap",
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: "var(--txt)",
                    fontFamily: "var(--font-sans, system-ui)",
                  }}>
                    {senseiText}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/* ─── Detalle por insumo ─── */}
          <div className="panel">
            <div className="panel-hd">
              <span className="panel-title">Detalle por insumo ({detalle.length})</span>
            </div>
            <div className="table-scroll-wrap">
              <table style={{ minWidth: 920 }}>
                <thead>
                  <tr>
                    <th>Insumo</th>
                    <th className="num-right">Stock inicial</th>
                    <th className="num-right">+ Compras</th>
                    <th className="num-right">− Stock final</th>
                    <th className="num-right">− Mermas</th>
                    <th className="num-right">= Real</th>
                    <th className="num-right">Teórico</th>
                    <th className="num-right">Diferencia</th>
                    <th className="num-right">Eficiencia</th>
                  </tr>
                </thead>
                <tbody>
                  {detalle.map(d => {
                    const dif = Number(d.diferencia_valor);
                    return (
                      <tr key={d.insumo_id} style={{
                        background: dif < -100 ? "rgba(220,38,38,0.04)" : undefined,
                      }}>
                        <td style={{ fontWeight: 500 }}>{d.insumo_nombre}</td>
                        <td className="num-right mono" style={{ fontSize: 11 }}>{Number(d.stock_inicial).toFixed(1)}</td>
                        <td className="num-right mono" style={{ fontSize: 11, color: "var(--success)" }}>{Number(d.compras_cantidad).toFixed(1)}</td>
                        <td className="num-right mono" style={{ fontSize: 11 }}>{Number(d.stock_final).toFixed(1)}</td>
                        <td className="num-right mono" style={{ fontSize: 11, color: "var(--warn)" }}>{Number(d.mermas_cantidad).toFixed(1)}</td>
                        <td className="num-right mono" style={{ fontWeight: 500 }}>{fmt_$(d.consumo_real_valor)}</td>
                        <td className="num-right mono">{fmt_$(d.consumo_teorico_valor)}</td>
                        <td className="num-right mono" style={{
                          color: dif < 0 ? "var(--danger)" : dif > 0 ? "var(--success)" : undefined,
                          fontWeight: Math.abs(dif) > 100 ? 600 : 400,
                        }}>
                          {fmt_$(dif)}
                        </td>
                        <td className="num-right mono" style={{ color: eficienciaColor(d.eficiencia_pct) }}>
                          {d.eficiencia_pct != null ? `${d.eficiencia_pct}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                  {detalle.length === 0 && (
                    <tr><td colSpan={9} style={{ textAlign: "center", padding: 24, color: "var(--muted2)" }}>
                      No hay movimientos de stock en este período.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ marginTop: 16, fontSize: 11, color: "var(--muted2)" }}>
            <strong>Fórmula:</strong> Real = Stock Inicial + Compras − Stock Final − Mermas.
            <strong> Eficiencia</strong> = Teórico / Real × 100. Si da 100%, la cocina es perfecta.
            Si da 80%, hay un 20% de pérdida no explicada (porcionado, fuga, etc.).
          </div>
        </>
      )}
    </div>
  );
}
