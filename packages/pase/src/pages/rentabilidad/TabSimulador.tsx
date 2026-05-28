// Tab Simulador: what-if con elasticidad
//
// Templates (4 escenarios pre-armados):
//   A) Cambio de precio de venta — subo/bajo precio de N platos
//   B) Cambio de costo de insumo — sube/baja proveedor
//   C) Mix de volumen — vendo más de X y menos de Y
//   D) Inflación global de insumos — sube todo X%
//
// Elasticidad configurable: ratio_global (-1 a 0) que dice cuánto baja
// el volumen al subir el precio. Default 0 (sin elasticidad).
//
// Persistencia: guarda escenarios en tabla `simulaciones`. Cada escenario
// puede recalcularse con fn_simular_escenario.

import { useState, useEffect } from "react";
import { db } from "../../lib/supabase";
import { fmt_$, toISO, today } from "../../lib/utils";
import { EmptyState, Modal } from "../../components/ui";
import { useToast } from "../../hooks/useToast";
import { ToastComponent } from "../../components/Toast";
import type { Usuario, Local } from "../../types";

interface Props {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

interface Simulacion {
  id: number;
  nombre: string;
  descripcion: string | null;
  local_id: number | null;
  periodo_desde: string;
  periodo_hasta: string;
  cambios: CambioJSON[];
  elasticidad: { ratio_global?: number };
  resultado: ResultadoJSON | null;
  calculado_at: string | null;
  created_at: string;
}

type CambioJSON =
  | { tipo: "precio_venta"; scope: "todos"; factor: number }
  | { tipo: "precio_venta"; item_ids: number[]; factor: number }
  | { tipo: "costo_insumo"; scope: "todos"; factor: number }
  | { tipo: "costo_insumo"; insumo_ids: number[]; factor: number }
  | { tipo: "mix_volumen"; item_ids: number[]; factor: number }
  | { tipo: "inflacion_global"; factor: number };

interface ResultadoJSON {
  real: { facturacion: number; costo: number; margen: number; margen_pct: number; items_vendidos: number };
  hipotetico: { facturacion: number; costo: number; margen: number; margen_pct: number; items_vendidos: number };
  delta: {
    facturacion: number; facturacion_pct: number;
    margen: number; margen_pct_pp: number;
    items_vendidos_pct: number;
  };
  elasticidad_aplicada: number;
  inflacion_aplicada: number;
  calculado_at: string;
}

type TipoTemplate = "precio" | "costo" | "mix" | "inflacion" | "custom";

const TEMPLATES = [
  { id: "precio" as TipoTemplate, label: "Cambio de precio de venta", emoji: "💲", desc: "Subo o bajo el precio de N platos" },
  { id: "costo" as TipoTemplate, label: "Cambio de costo de insumo", emoji: "📈", desc: "Un proveedor sube/baja el precio" },
  { id: "mix" as TipoTemplate, label: "Mix de volumen", emoji: "🔀", desc: "Vendo más de X y menos de Y" },
  { id: "inflacion" as TipoTemplate, label: "Inflación global", emoji: "🌪", desc: "Suben TODOS los insumos" },
];

export function TabSimulador({ user, locales, localActivo }: Props) {
  const [simulaciones, setSimulaciones] = useState<Simulacion[]>([]);
  const [loading, setLoading] = useState(true);
  const [modoCrear, setModoCrear] = useState<TipoTemplate | null>(null);
  const [calculando, setCalculando] = useState<number | null>(null);
  const [verResultado, setVerResultado] = useState<Simulacion | null>(null);
  const { toast, showToast, showError } = useToast();

  // Form state para nueva simulación
  const [nuevo, setNuevo] = useState({
    nombre: "",
    desde: toISO(new Date(today.getFullYear(), today.getMonth() - 1, 1)),  // mes pasado
    hasta: toISO(new Date(today.getFullYear(), today.getMonth(), 0)),       // último día mes pasado
    local_id: localActivo,
    factor_pct: 10,           // cambio en %
    elasticidad_ratio: 0,     // -0.5 = pierdo 5% al subir 10%
  });

  const tenantId = user.tenant_id;

  // Cargar simulaciones existentes
  const load = async () => {
    setLoading(true);
    const { data } = await db.from("simulaciones")
      .select("*")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(20);
    setSimulaciones((data as Simulacion[]) || []);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const locsDisp = locales.filter(l =>
    user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin"
    || (user._locales || user.locales || []).includes(l.id)
  );

  const localNombre = (id: number | null) => id == null ? "Todos los locales" : (locales.find(l => l.id === id)?.nombre || `Local #${id}`);

  // Crear simulación según template
  const crearSimulacion = async () => {
    if (!nuevo.nombre.trim()) { showError("Falta nombre"); return; }
    if (!modoCrear) return;

    const factor = 1 + (nuevo.factor_pct / 100);

    // Armar `cambios` según template
    let cambios: CambioJSON[] = [];
    let descripcion = "";
    if (modoCrear === "precio") {
      cambios = [{ tipo: "precio_venta", scope: "todos", factor }];
      descripcion = `Subo precio de TODOS los platos ${nuevo.factor_pct >= 0 ? "+" : ""}${nuevo.factor_pct}%`;
    } else if (modoCrear === "costo") {
      cambios = [{ tipo: "costo_insumo", scope: "todos", factor }];
      descripcion = `Cambio de costo de TODOS los insumos ${nuevo.factor_pct >= 0 ? "+" : ""}${nuevo.factor_pct}%`;
    } else if (modoCrear === "mix") {
      cambios = [{ tipo: "mix_volumen", item_ids: [], factor }];
      descripcion = `Mix de volumen (sin items específicos seleccionados — usa form custom para detallar)`;
    } else if (modoCrear === "inflacion") {
      cambios = [{ tipo: "inflacion_global", factor }];
      descripcion = `Inflación global de insumos ${nuevo.factor_pct >= 0 ? "+" : ""}${nuevo.factor_pct}%`;
    }

    const elasticidad = nuevo.elasticidad_ratio !== 0
      ? { ratio_global: nuevo.elasticidad_ratio }
      : {};

    const { data, error } = await db.from("simulaciones").insert({
      tenant_id: tenantId,
      nombre: nuevo.nombre.trim(),
      descripcion,
      local_id: nuevo.local_id,
      periodo_desde: nuevo.desde,
      periodo_hasta: nuevo.hasta,
      cambios,
      elasticidad,
    }).select().single();

    if (error) { showError("Error: " + error.message); return; }

    const sim = data as Simulacion;
    setModoCrear(null);
    setNuevo(n => ({ ...n, nombre: "" }));
    await load();
    // Auto-calcular
    await calcular(sim.id);
  };

  // Calcular escenario
  const calcular = async (id: number) => {
    setCalculando(id);
    const { error } = await db.rpc("fn_simular_escenario", { p_simulacion_id: id });
    setCalculando(null);
    if (error) { showError("Error: " + error.message); return; }
    await load();
  };

  // Eliminar simulación
  const eliminar = async (id: number, nombre: string) => {
    if (!confirm(`¿Eliminar simulación "${nombre}"?`)) return;
    await db.from("simulaciones").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    await load();
  };

  return (
    <div>
      {/* ─── Header acción ─── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <div style={{ fontSize: 13, color: "var(--muted2)", maxWidth: 600 }}>
          Simulá cómo afectaría tu rentabilidad un cambio de precio, costo o volumen.
          El sistema usa ventas históricas reales y recalcula como si los cambios
          hubieran existido ese período. Si configurás elasticidad, también ajusta
          el volumen vendido según el cambio de precio.
        </div>
      </div>

      {/* ─── Templates para crear ─── */}
      {!modoCrear && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-hd"><span className="panel-title">+ Nueva simulación</span></div>
          <div style={{ padding: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            {TEMPLATES.map(t => (
              <button
                key={t.id}
                onClick={() => setModoCrear(t.id)}
                style={{
                  textAlign: "left",
                  padding: 14,
                  border: "1px solid var(--bd)",
                  background: "var(--s2)",
                  borderRadius: 8,
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <div style={{ fontSize: 22 }}>{t.emoji}</div>
                <div style={{ fontWeight: 500, color: "var(--text)" }}>{t.label}</div>
                <div style={{ fontSize: 11, color: "var(--muted2)" }}>{t.desc}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ─── Form de creación ─── */}
      {modoCrear && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-hd">
            <span className="panel-title">
              {TEMPLATES.find(t => t.id === modoCrear)?.emoji} {TEMPLATES.find(t => t.id === modoCrear)?.label}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => setModoCrear(null)}>✕ Cancelar</button>
          </div>
          <div style={{ padding: 14 }}>
            <div className="form2" style={{ marginBottom: 12 }}>
              <div className="field">
                <label>Nombre *</label>
                <input value={nuevo.nombre} onChange={e => setNuevo(n => ({ ...n, nombre: e.target.value }))} placeholder="Ej: Subir precios 10% mes pasado" />
              </div>
              <div className="field">
                <label>Local</label>
                <select value={nuevo.local_id ?? ""} onChange={e => setNuevo(n => ({ ...n, local_id: e.target.value ? Number(e.target.value) : null }))}>
                  <option value="">Todos los locales</option>
                  {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
                </select>
              </div>
            </div>

            <div className="form2" style={{ marginBottom: 12 }}>
              <div className="field">
                <label>Período desde *</label>
                <input type="date" value={nuevo.desde} onChange={e => setNuevo(n => ({ ...n, desde: e.target.value }))} />
              </div>
              <div className="field">
                <label>Período hasta *</label>
                <input type="date" value={nuevo.hasta} onChange={e => setNuevo(n => ({ ...n, hasta: e.target.value }))} />
              </div>
            </div>

            <div className="form2" style={{ marginBottom: 12 }}>
              <div className="field">
                <label>
                  Cambio % {nuevo.factor_pct >= 0 ? "(↑ sube)" : "(↓ baja)"}
                </label>
                <input
                  type="range"
                  min={-50}
                  max={50}
                  step={1}
                  value={nuevo.factor_pct}
                  onChange={e => setNuevo(n => ({ ...n, factor_pct: Number(e.target.value) }))}
                />
                <div style={{ textAlign: "center", fontSize: 18, fontWeight: 500, marginTop: 6 }}>
                  {nuevo.factor_pct >= 0 ? "+" : ""}{nuevo.factor_pct}%
                </div>
              </div>
              {modoCrear === "precio" && (
                <div className="field">
                  <label>
                    Elasticidad <span style={{ fontSize: 10, color: "var(--muted2)" }}>(opcional)</span>
                  </label>
                  <input
                    type="range"
                    min={-1}
                    max={0}
                    step={0.1}
                    value={nuevo.elasticidad_ratio}
                    onChange={e => setNuevo(n => ({ ...n, elasticidad_ratio: Number(e.target.value) }))}
                  />
                  <div style={{ textAlign: "center", fontSize: 11, color: "var(--muted2)", marginTop: 6 }}>
                    {nuevo.elasticidad_ratio === 0
                      ? "Sin elasticidad (vendo lo mismo)"
                      : `Por cada +1% precio, ${(nuevo.elasticidad_ratio * 100).toFixed(0)}% volumen`}
                  </div>
                </div>
              )}
            </div>

            <div style={{ fontSize: 11, color: "var(--muted2)", padding: 8, background: "var(--s2)", borderRadius: 6, marginBottom: 12 }}>
              {modoCrear === "precio" && `📌 Sube/baja el precio de TODOS los platos un ${nuevo.factor_pct}%. Si configurás elasticidad, también ajusta el volumen vendido.`}
              {modoCrear === "costo" && `📌 Sube/baja el costo de TODOS los insumos un ${nuevo.factor_pct}%. Útil para simular cambio de proveedor.`}
              {modoCrear === "mix" && `📌 Modificás el mix de volumen vendido. Esta versión inicial aplica el factor a todos los items.`}
              {modoCrear === "inflacion" && `📌 Inflación global: todos los insumos cuestan ${nuevo.factor_pct}% más. Útil para escenarios macro.`}
            </div>

            <button className="btn btn-acc" onClick={crearSimulacion} disabled={!nuevo.nombre.trim()}>
              Crear y calcular
            </button>
          </div>
        </div>
      )}

      {/* ─── Lista de simulaciones ─── */}
      {loading ? (
        <div className="loading">Cargando simulaciones...</div>
      ) : simulaciones.length === 0 ? (
        <EmptyState
          icon="🧪"
          title="Ninguna simulación todavía"
          description="Creá tu primera simulación arriba: un escenario de cambio de precios, costos, mix o inflación. Los resultados se guardan para que puedas comparar."
        />
      ) : (
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">Simulaciones guardadas ({simulaciones.length})</span></div>
          <div className="table-scroll-wrap">
            <table style={{ minWidth: 800 }}>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Período</th>
                  <th>Local</th>
                  <th className="num-right">Δ Facturación</th>
                  <th className="num-right">Δ Margen</th>
                  <th className="num-right">Δ Volumen</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {simulaciones.map(s => (
                  <tr key={s.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{s.nombre}</div>
                      <div style={{ fontSize: 10, color: "var(--muted2)" }}>{s.descripcion}</div>
                    </td>
                    <td style={{ fontSize: 11, color: "var(--muted2)" }} className="mono">
                      {s.periodo_desde} → {s.periodo_hasta}
                    </td>
                    <td style={{ fontSize: 11 }}>{localNombre(s.local_id)}</td>
                    <td className="num-right mono" style={{ color: s.resultado ? (s.resultado.delta.facturacion >= 0 ? "var(--success)" : "var(--danger)") : "var(--muted2)" }}>
                      {s.resultado ? `${s.resultado.delta.facturacion_pct >= 0 ? "+" : ""}${s.resultado.delta.facturacion_pct}%` : "—"}
                    </td>
                    <td className="num-right mono" style={{ color: s.resultado ? (s.resultado.delta.margen >= 0 ? "var(--success)" : "var(--danger)") : "var(--muted2)" }}>
                      {s.resultado ? fmt_$(s.resultado.delta.margen) : "—"}
                    </td>
                    <td className="num-right mono" style={{ fontSize: 11 }}>
                      {s.resultado ? `${s.resultado.delta.items_vendidos_pct >= 0 ? "+" : ""}${s.resultado.delta.items_vendidos_pct}%` : "—"}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setVerResultado(s)} disabled={!s.resultado}>
                          Ver
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => calcular(s.id)} disabled={calculando === s.id}>
                          {calculando === s.id ? "..." : "Recalcular"}
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => eliminar(s.id, s.nombre)}>×</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {toast && <ToastComponent toast={toast} />}
      {/* ─── Modal detalle ─── */}
      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido. */}
      <Modal
        isOpen={!!(verResultado && verResultado.resultado)}
        onClose={() => setVerResultado(null)}
        title={verResultado?.nombre || ""}
        subtitle={verResultado?.descripcion ?? undefined}
        maxWidth={700}
      >
        {verResultado?.resultado && (
          <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                <div style={{ padding: 12, background: "var(--s2)", borderRadius: 8 }}>
                  <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 }}>Real</div>
                  <div style={{ marginTop: 6, fontSize: 12 }}>Facturación: <strong>{fmt_$(verResultado.resultado.real.facturacion)}</strong></div>
                  <div style={{ fontSize: 12 }}>Costo: <strong>{fmt_$(verResultado.resultado.real.costo)}</strong></div>
                  <div style={{ fontSize: 12 }}>Margen: <strong>{fmt_$(verResultado.resultado.real.margen)} ({verResultado.resultado.real.margen_pct}%)</strong></div>
                  <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 4 }}>
                    {Math.round(verResultado.resultado.real.items_vendidos)} items vendidos
                  </div>
                </div>
                <div style={{ padding: 12, background: "rgba(34,197,94,0.06)", borderRadius: 8, border: "1px solid rgba(34,197,94,0.25)" }}>
                  <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 }}>Hipotético</div>
                  <div style={{ marginTop: 6, fontSize: 12 }}>Facturación: <strong>{fmt_$(verResultado.resultado.hipotetico.facturacion)}</strong></div>
                  <div style={{ fontSize: 12 }}>Costo: <strong>{fmt_$(verResultado.resultado.hipotetico.costo)}</strong></div>
                  <div style={{ fontSize: 12 }}>Margen: <strong>{fmt_$(verResultado.resultado.hipotetico.margen)} ({verResultado.resultado.hipotetico.margen_pct}%)</strong></div>
                  <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 4 }}>
                    {Math.round(verResultado.resultado.hipotetico.items_vendidos)} items vendidos
                  </div>
                </div>
              </div>
              <div style={{ padding: 14, background: verResultado.resultado.delta.margen >= 0 ? "rgba(34,197,94,0.1)" : "rgba(220,38,38,0.1)", borderRadius: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>
                  {verResultado.resultado.delta.margen >= 0 ? "✅ Cambio favorable" : "⚠ Cambio negativo"}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, fontSize: 12 }}>
                  <div>
                    <div style={{ color: "var(--muted)" }}>Facturación</div>
                    <div style={{ fontSize: 16, fontWeight: 500 }}>
                      {verResultado.resultado.delta.facturacion >= 0 ? "+" : ""}{fmt_$(verResultado.resultado.delta.facturacion)}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted2)" }}>
                      ({verResultado.resultado.delta.facturacion_pct >= 0 ? "+" : ""}{verResultado.resultado.delta.facturacion_pct}%)
                    </div>
                  </div>
                  <div>
                    <div style={{ color: "var(--muted)" }}>Margen</div>
                    <div style={{ fontSize: 16, fontWeight: 500 }}>
                      {verResultado.resultado.delta.margen >= 0 ? "+" : ""}{fmt_$(verResultado.resultado.delta.margen)}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted2)" }}>
                      ({verResultado.resultado.delta.margen_pct_pp >= 0 ? "+" : ""}{verResultado.resultado.delta.margen_pct_pp} pp)
                    </div>
                  </div>
                  <div>
                    <div style={{ color: "var(--muted)" }}>Volumen</div>
                    <div style={{ fontSize: 16, fontWeight: 500 }}>
                      {verResultado.resultado.delta.items_vendidos_pct >= 0 ? "+" : ""}{verResultado.resultado.delta.items_vendidos_pct}%
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted2)" }}>
                      {verResultado.resultado.elasticidad_aplicada !== 0
                        ? `elasticidad ${verResultado.resultado.elasticidad_aplicada}`
                        : "sin elasticidad"}
                    </div>
                  </div>
                </div>
              </div>
              {verResultado.calculado_at && (
                <div style={{ fontSize: 10, color: "var(--muted)", textAlign: "center", marginTop: 12 }}>
                  Calculado: {new Date(verResultado.calculado_at).toLocaleString("es-AR")}
                </div>
              )}
          </>
        )}
      </Modal>
    </div>
  );
}
