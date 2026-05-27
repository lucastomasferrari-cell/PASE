// Tab "Compras Sugeridas" — Par-level forecast.
//
// Implementación del ticket "🛒 Calculador de compras semanal" pedido por
// Lucas. Patrón industria: Toast/R365/MarginEdge lo llaman "par level".
//
// Concepto: el dueño elige cuántos días quiere cubrir (default 7d) y un
// safety stock %. El sistema lee historia de consumo (últimos 28d) y
// sugiere cuánto comprar de cada insumo + costo total estimado.
//
// La RPC `fn_par_level_forecast` (migration 202605252000) hace toda la
// matemática server-side. Esta UI solo presenta y filtra.

import { useState, useEffect, useMemo } from "react";
import { db } from "../../lib/supabase";
import { fmt_$, todayAR_ISO } from '../../lib/utils';
import { EmptyState } from "../../components/ui";
import type { Usuario, Local } from "../../types";

interface Props {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

interface ForecastRow {
  insumo_id: number;
  insumo_nombre: string;
  unidad: string;
  categoria_pl: string | null;
  stock_actual: number;
  costo_actual: number;
  uso_diario_promedio: number;
  uso_semanal_promedio: number;
  uso_mensual_promedio: number;
  dias_aguanta: number | null;
  cantidad_sugerida: number;
  costo_estimado_compra: number;
  proveedor_preferido_id: number | null;
  proveedor_preferido_nombre: string | null;
  estado_urgencia: 'agotado' | 'urgente' | 'pronto' | 'ok' | 'sin_datos' | 'sin_movimiento';
  datos_insuficientes: boolean;
}

interface EstadoCfg { label: string; color: string; orden: number }
const ESTADO_CFG: Record<string, EstadoCfg> = {
  agotado:        { label: "🚨 Agotado",         color: "var(--danger)", orden: 1 },
  urgente:        { label: "🔴 Urgente (<2d)",   color: "var(--danger)", orden: 2 },
  pronto:         { label: "🟡 Pronto (<7d)",    color: "var(--warn)",   orden: 3 },
  ok:             { label: "🟢 Stock OK",        color: "var(--success)", orden: 4 },
  sin_movimiento: { label: "⏸️ Sin venta 28d",   color: "var(--muted2)", orden: 5 },
  sin_datos:      { label: "❓ Sin datos",       color: "var(--muted2)", orden: 6 },
};
const FALLBACK_CFG: EstadoCfg = { label: "❓ Sin datos", color: "var(--muted2)", orden: 6 };

export function TabComprasSugeridas({ user, locales, localActivo }: Props) {
  const [diasHorizonte, setDiasHorizonte] = useState(7);
  const [safetyStock, setSafetyStock] = useState(20);
  const [diasHistoria, setDiasHistoria] = useState(28);
  const [localFiltro, setLocalFiltro] = useState<number | null>(localActivo);
  const [rows, setRows] = useState<ForecastRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [filtroEstado, setFiltroEstado] = useState<string>("");

  const tenantId = user.tenant_id;
  const locsDisp = locales.filter(l => !user.locales || user.locales.includes(l.id));

  useEffect(() => {
    if (!tenantId || !localFiltro) return;
    (async () => {
      setLoading(true);
      const { data, error } = await db.rpc("fn_par_level_forecast", {
        p_tenant_id: tenantId,
        p_local_id: localFiltro,
        p_dias_horizonte: diasHorizonte,
        p_safety_stock_pct: safetyStock,
        p_dias_historia: diasHistoria,
      });
      if (error) console.error("[compras-sugeridas]", error);
      setRows((data as ForecastRow[]) ?? []);
      setLoading(false);
    })();
  }, [tenantId, localFiltro, diasHorizonte, safetyStock, diasHistoria]);

  // Filtrado por estado urgencia
  const rowsFiltradas = useMemo(() => {
    if (!filtroEstado) return rows;
    return rows.filter(r => r.estado_urgencia === filtroEstado);
  }, [rows, filtroEstado]);

  // KPIs
  const totalAComprar = rowsFiltradas.reduce((s, r) => s + Number(r.costo_estimado_compra ?? 0), 0);
  const insumosACompar = rowsFiltradas.filter(r => Number(r.cantidad_sugerida) > 0).length;
  const insumosUrgentes = rows.filter(r => r.estado_urgencia === 'urgente' || r.estado_urgencia === 'agotado').length;
  const insumosSinDatos = rows.filter(r => r.datos_insuficientes).length;

  // Agrupación por proveedor para "Generar orden de compra"
  const porProveedor = useMemo(() => {
    const map = new Map<string, { nombre: string; total: number; insumos: ForecastRow[] }>();
    for (const r of rows) {
      if (Number(r.cantidad_sugerida) <= 0) continue;
      const key = r.proveedor_preferido_id != null ? String(r.proveedor_preferido_id) : "sin_proveedor";
      const nombre = r.proveedor_preferido_nombre ?? "Sin proveedor preferido";
      const cur = map.get(key) ?? { nombre, total: 0, insumos: [] };
      cur.total += Number(r.costo_estimado_compra);
      cur.insumos.push(r);
      map.set(key, cur);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].total - a[1].total);
  }, [rows]);

  const [generandoRemitos, setGenerandoRemitos] = useState(false);
  async function generarRemitos() {
    if (!localFiltro || porProveedor.length === 0) return;
    const proveedoresValidos = porProveedor.filter(([key]) => key !== "sin_proveedor");
    if (proveedoresValidos.length === 0) {
      alert("Ningún insumo sugerido tiene proveedor asignado. Definí proveedor preferido vía materias_primas primero.");
      return;
    }
    const resumen = proveedoresValidos.map(([, p]) => `• ${p.nombre}: ${p.insumos.length} items · ${fmt_$(p.total)}`).join("\n");
    if (!confirm(`Vas a crear ${proveedoresValidos.length} remito(s) pendientes:\n\n${resumen}\n\nDespués los editás/confirmás desde Compras → Remitos.\n¿Continuar?`)) {
      return;
    }
    setGenerandoRemitos(true);
    try {
      const fecha = todayAR_ISO();
      const remitosACrear = proveedoresValidos.map(([key, p]) => {
        const provId = key !== "sin_proveedor" ? parseInt(key) : null;
        const detalleItems = p.insumos
          .map(i => `${i.insumo_nombre}: ${Number(i.cantidad_sugerida).toFixed(2)} ${i.unidad}`)
          .join(" | ");
        return {
          id: `REM-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          tenant_id: tenantId,
          local_id: localFiltro,
          prov_id: provId,
          fecha,
          nro: `AUTO-${Date.now().toString().slice(-6)}`,
          monto: Math.round(p.total),
          detalle: `[AUTO-FORECAST ${diasHorizonte}d/+${safetyStock}%] ${detalleItems}`,
          cuenta: "Caja Efectivo",
          estado: "sin_factura",
          cat: "INSUMOS COCINA",
        };
      });
      // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F12: cargar remito debe ir por RPC crear_remito atómica. Hoy se respeta la convención de Compras.tsx (insert directo). Migrar todo junto.
      const { error } = await db.from("remitos").insert(remitosACrear);
      if (error) throw new Error(error.message);
      alert(`✓ ${remitosACrear.length} remito(s) creado(s).\nVas a verlos en Compras → Remitos para editar/confirmar.`);
      // Recargar el forecast (los datos no cambian, pero la UI siente refresco)
    } catch (e) {
      alert(`Error generando remitos: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setGenerandoRemitos(false);
    }
  }

  // Distribución por estado para chips
  const porEstado = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.estado_urgencia, (m.get(r.estado_urgencia) ?? 0) + 1);
    return m;
  }, [rows]);

  return (
    <div>
      {/* ─── Controles ─── */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-hd" style={{ flexWrap: "wrap", gap: 12 }}>
          <span className="panel-title">Configuración del forecast</span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ fontSize: 11, color: "var(--muted2)" }}>
              Local:
              <select className="search" style={{ width: 200, marginLeft: 6 }}
                value={localFiltro ?? ""}
                onChange={e => setLocalFiltro(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Seleccioná local...</option>
                {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 11, color: "var(--muted2)" }}>
              Cubrir:
              <select className="search" style={{ width: 90, marginLeft: 6 }} value={diasHorizonte}
                onChange={e => setDiasHorizonte(Number(e.target.value))}>
                <option value={3}>3 días</option>
                <option value={7}>7 días</option>
                <option value={10}>10 días</option>
                <option value={14}>14 días</option>
                <option value={21}>21 días</option>
                <option value={30}>30 días</option>
              </select>
            </label>
            <label style={{ fontSize: 11, color: "var(--muted2)" }}>
              Safety:
              <select className="search" style={{ width: 80, marginLeft: 6 }} value={safetyStock}
                onChange={e => setSafetyStock(Number(e.target.value))}>
                <option value={0}>0%</option>
                <option value={10}>10%</option>
                <option value={20}>20%</option>
                <option value={30}>30%</option>
                <option value={50}>50%</option>
              </select>
            </label>
            <label style={{ fontSize: 11, color: "var(--muted2)" }}>
              Historia:
              <select className="search" style={{ width: 100, marginLeft: 6 }} value={diasHistoria}
                onChange={e => setDiasHistoria(Number(e.target.value))}>
                <option value={14}>14 días</option>
                <option value={28}>28 días</option>
                <option value={56}>56 días</option>
                <option value={90}>90 días</option>
              </select>
            </label>
          </div>
        </div>
      </div>

      {!localFiltro ? (
        <EmptyState icon="🛒" title="Elegí un local"
          description="El forecast se calcula por local. Seleccioná uno arriba." />
      ) : loading ? (
        <div className="loading">Calculando forecast…</div>
      ) : rows.length === 0 ? (
        <EmptyState icon="📦" title="Sin insumos en este local"
          description="No hay insumos cargados para este local. Cargá insumos desde COMANDA → Menú → Insumos." />
      ) : (
        <>
          {/* ─── KPIs ─── */}
          <div className="grid3" style={{ marginBottom: 16 }}>
            <div className="kpi">
              <div className="kpi-label">Total a comprar (estimado)</div>
              <div className="kpi-value kpi-acc" style={{ fontSize: 22 }}>{fmt_$(totalAComprar)}</div>
              <div className="kpi-sub">para cubrir {diasHorizonte} días + {safetyStock}% safety</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Insumos a comprar</div>
              <div className="kpi-value" style={{ fontSize: 22 }}>{insumosACompar}</div>
              <div className="kpi-sub">de {rows.length} insumos totales</div>
            </div>
            <div className="kpi" style={{ background: insumosUrgentes > 0 ? "rgba(220,38,38,0.06)" : undefined }}>
              <div className="kpi-label">Urgentes / agotados</div>
              <div className="kpi-value" style={{ fontSize: 22, color: insumosUrgentes > 0 ? "var(--danger)" : "var(--success)" }}>
                {insumosUrgentes}
              </div>
              <div className="kpi-sub">comprar HOY</div>
            </div>
          </div>

          {/* ─── Botón Generar Remitos (agrupados por proveedor) ─── */}
          {insumosACompar > 0 && (
            <div className="panel" style={{ marginBottom: 16, padding: "12px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <strong style={{ fontSize: 13 }}>📋 Generar remitos automáticos</strong>
                  <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 4 }}>
                    Crea {porProveedor.filter(([k]) => k !== "sin_proveedor").length} remito(s) pendiente(s) agrupado(s) por proveedor preferido.
                    Después los editás y confirmás desde <strong>Compras → Remitos</strong>.
                  </div>
                </div>
                <button
                  onClick={generarRemitos}
                  disabled={generandoRemitos || porProveedor.filter(([k]) => k !== "sin_proveedor").length === 0}
                  className="btn btn-acc"
                  title={porProveedor.filter(([k]) => k !== "sin_proveedor").length === 0
                    ? "Ningún insumo sugerido tiene proveedor asignado"
                    : "Crear remitos pre-llenados"}
                >
                  {generandoRemitos ? "Generando…" : `Generar ${porProveedor.filter(([k]) => k !== "sin_proveedor").length} remito(s)`}
                </button>
              </div>
            </div>
          )}

          {/* ─── Chips de filtro por estado ─── */}
          <div className="panel" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 6, padding: 12, flexWrap: "wrap" }}>
              <button onClick={() => setFiltroEstado("")}
                className={`btn ${filtroEstado === "" ? "btn-acc" : "btn-ghost"} btn-sm`}>
                Todos ({rows.length})
              </button>
              {Object.entries(ESTADO_CFG)
                .sort((a, b) => a[1].orden - b[1].orden)
                .map(([id, cfg]) => {
                  const count = porEstado.get(id) ?? 0;
                  if (count === 0) return null;
                  return (
                    <button key={id} onClick={() => setFiltroEstado(id)}
                      className={`btn ${filtroEstado === id ? "btn-acc" : "btn-ghost"} btn-sm`}>
                      {cfg.label} ({count})
                    </button>
                  );
                })}
            </div>
          </div>

          {/* ─── Tabla principal ─── */}
          <div className="panel">
            <div className="panel-hd">
              <span className="panel-title">Forecast por insumo ({rowsFiltradas.length})</span>
              {insumosSinDatos > 0 && (
                <span style={{ fontSize: 11, color: "var(--muted2)" }}>
                  {insumosSinDatos} insumos sin historia suficiente — no se sugiere compra
                </span>
              )}
            </div>
            <div className="table-scroll-wrap">
              <table style={{ minWidth: 920 }}>
                <thead>
                  <tr>
                    <th>Insumo</th>
                    <th className="num-right">Stock</th>
                    <th className="num-right">Uso/día</th>
                    <th className="num-right">Uso/sem</th>
                    <th className="num-right">Uso/mes</th>
                    <th className="num-right">Aguanta</th>
                    <th className="num-right">Sugerido</th>
                    <th className="num-right">Costo est.</th>
                    <th>Proveedor</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {rowsFiltradas.map(r => {
                    const cfg: EstadoCfg = ESTADO_CFG[r.estado_urgencia] ?? FALLBACK_CFG;
                    const usoD = Number(r.uso_diario_promedio);
                    const sugerido = Number(r.cantidad_sugerida);
                    return (
                      <tr key={r.insumo_id} style={{
                        background: r.estado_urgencia === 'urgente' || r.estado_urgencia === 'agotado'
                          ? "rgba(220,38,38,0.04)" : undefined,
                      }}>
                        <td style={{ fontWeight: 500 }}>{r.insumo_nombre}</td>
                        <td className="num-right mono">
                          {Number(r.stock_actual).toFixed(1)} <span style={{ fontSize: 10, color: "var(--muted2)" }}>{r.unidad}</span>
                        </td>
                        <td className="num-right mono" style={{ fontSize: 11 }}>
                          {r.datos_insuficientes ? <span style={{ color: "var(--muted2)" }}>?</span> : usoD.toFixed(2)}
                        </td>
                        <td className="num-right mono" style={{ fontSize: 11 }}>
                          {r.datos_insuficientes ? "?" : Number(r.uso_semanal_promedio).toFixed(1)}
                        </td>
                        <td className="num-right mono" style={{ fontSize: 11 }}>
                          {r.datos_insuficientes ? "?" : Number(r.uso_mensual_promedio).toFixed(1)}
                        </td>
                        <td className="num-right mono" style={{ fontSize: 11, color: cfg.color }}>
                          {r.dias_aguanta != null ? `${r.dias_aguanta}d` : "—"}
                        </td>
                        <td className="num-right mono" style={{ fontWeight: 600, color: sugerido > 0 ? "var(--acc)" : "var(--muted2)" }}>
                          {sugerido > 0 ? `${sugerido.toFixed(1)} ${r.unidad}` : "—"}
                        </td>
                        <td className="num-right mono" style={{ fontWeight: 500 }}>
                          {Number(r.costo_estimado_compra) > 0 ? fmt_$(r.costo_estimado_compra) : "—"}
                        </td>
                        <td style={{ fontSize: 11, color: "var(--muted2)" }}>
                          {r.proveedor_preferido_nombre || <span style={{ opacity: 0.5 }}>—</span>}
                        </td>
                        <td style={{ fontSize: 11, color: cfg.color, fontWeight: 500 }}>{cfg.label}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ marginTop: 16, fontSize: 11, color: "var(--muted2)" }}>
            <strong>Fórmula:</strong> Sugerido = (Uso diario × días a cubrir × (1 + safety%)) − stock actual.
            Se redondea hacia arriba. Datos: consumo de últimos {diasHistoria} días (movs salida_venta + mermas).
            Insumos con &lt; 2 semanas de historia → "sin datos" (no se sugiere).
          </div>
        </>
      )}
    </div>
  );
}
