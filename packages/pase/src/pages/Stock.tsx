// ─── STOCK ────────────────────────────────────────────────────────────────
// Pieza C — Stock en PASE. Spec: docs/superpowers/specs/2026-05-28-stock-cmv-avt-rediseno.md
//
// El stock se suma con las compras (factura → trigger), se resta con las ventas
// (fn_aplicar_stock_venta, resuelve sub-recetas) y las mermas, y se corrobora
// con CONTEOS CIEGOS: el empleado carga lo que contó SIN ver el teórico, y al
// finalizar recién aparece la diferencia real.
//
// Backend ya existente: insumos.stock_actual (cache via trigger), stock_conteos
// + stock_conteo_lineas (teorico/contado/diferencia), mermas_motivos, y las RPCs
// fn_iniciar_conteo_fisico / fn_cargar_conteo_linea / fn_finalizar_conteo_fisico
// / fn_registrar_merma.

import { useState, useEffect, useCallback } from "react";
import { db } from "../lib/supabase";
import { tienePermiso } from "../lib/auth";
import { useGuardedHandler } from "../lib/useGuardedHandler";
import { translateRpcError } from "../lib/errors";
import { fmt_$ } from "@pase/shared/utils";
import type { Usuario, Local } from "../types/auth";
import { Modal } from "../components/ui";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";

interface StockLocalRow { local_id: number; cantidad: number; }
interface Insumo {
  id: number;
  nombre: string;
  unidad: string;
  emoji: string | null;
  stock_actual: number | null;
  stock_minimo: number | null;
  stock_maximo: number | null;
  costo_actual: number | null;
  insumo_stock_local?: StockLocalRow[];
}
interface MotivoMerma { id: number; nombre: string; emoji: string | null; }
interface Conteo {
  id: number; local_id: number; estado: string; notas: string | null;
  iniciado_at: string; finalizado_at: string | null;
  total_insumos: number | null; total_ajustes: number | null; valor_diferencia: number | null;
}
interface ConteoLinea {
  id: number; insumo_id: number; stock_teorico: number | null;
  stock_contado: number | null; diferencia: number | null;
  insumo_nombre?: string; insumo_unidad?: string;
}

type Vista = "stock" | "conteo" | "mermas" | "historial";

interface StockProps {
  user: Usuario;
  locales?: Local[];
  localActivo: number | null;
  embedded?: boolean;
}

const fmtDt = (s: string) => new Date(s).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Stock a mostrar: con local activo → cantidad de ESE local (0 si no hay fila);
// sin local activo (dueño viendo todo) → stock_actual global.
const stockVisible = (ins: Pick<Insumo, "stock_actual" | "insumo_stock_local">, localActivo: number | null): number => {
  if (localActivo != null) {
    const fila = (ins.insumo_stock_local ?? []).find(l => l.local_id === localActivo);
    return Number(fila?.cantidad ?? 0);
  }
  return Number(ins.stock_actual ?? 0);
};

export default function Stock({ user, localActivo, embedded = false }: StockProps) {
  const { toast, showError, showToast } = useToast();
  const [vista, setVista] = useState<Vista>("stock");
  const [insumos, setInsumos] = useState<Insumo[]>([]);
  const [motivos, setMotivos] = useState<MotivoMerma[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Conteo
  const [conteoAbierto, setConteoAbierto] = useState<Conteo | null>(null);
  const [lineas, setLineas] = useState<ConteoLinea[]>([]);
  const [contadoEdits, setContadoEdits] = useState<Record<number, string>>({}); // insumo_id → valor tipeado
  const [conteoFinalizado, setConteoFinalizado] = useState<Conteo | null>(null); // recién cerrado → revelar

  // Mermas
  const [mermaModal, setMermaModal] = useState(false);
  const [mermaForm, setMermaForm] = useState({ insumo_id: "", cantidad: "", motivo_id: "", notas: "" });

  // Historial
  const [conteos, setConteos] = useState<Conteo[]>([]);
  const [detalleConteo, setDetalleConteo] = useState<{ conteo: Conteo; lineas: ConteoLinea[] } | null>(null);

  const puede = tienePermiso(user, "rentabilidad") || tienePermiso(user, "compras") || user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin";

  const verDetalle = async (conteo: Conteo) => {
    const { data: ls } = await db.from("stock_conteo_lineas")
      .select("id, insumo_id, stock_teorico, stock_contado, diferencia, insumos(nombre, unidad)")
      .eq("conteo_id", conteo.id).order("id");
    type LR = ConteoLinea & { insumos?: { nombre: string; unidad: string } | { nombre: string; unidad: string }[] | null };
    const pl = ((ls || []) as unknown as LR[]).map(l => {
      const ins = Array.isArray(l.insumos) ? l.insumos[0] : l.insumos;
      return { ...l, insumo_nombre: ins?.nombre, insumo_unidad: ins?.unidad };
    });
    setDetalleConteo({ conteo, lineas: pl });
  };

  const cargarBase = useCallback(async () => {
    setLoading(true);
    const [iRes, mRes] = await Promise.all([
      db.from("insumos").select("id, nombre, unidad, emoji, stock_actual, stock_minimo, stock_maximo, costo_actual, insumo_stock_local(local_id, cantidad)")
        .eq("activo", true).is("deleted_at", null).order("nombre"),
      db.from("mermas_motivos").select("id, nombre, emoji").eq("activo", true).is("deleted_at", null).order("orden"),
    ]);
    if (iRes.error) { showError("No se pudo cargar stock: " + iRes.error.message); setLoading(false); return; }
    setInsumos((iRes.data || []) as Insumo[]);
    setMotivos((mRes.data || []) as MotivoMerma[]);
    setLoading(false);
  }, [showError]);

  const cargarConteoAbierto = useCallback(async () => {
    if (!localActivo) { setConteoAbierto(null); setLineas([]); return; }
    const { data: cs } = await db.from("stock_conteos")
      .select("id, local_id, estado, notas, iniciado_at, finalizado_at, total_insumos, total_ajustes, valor_diferencia")
      .eq("local_id", localActivo).eq("estado", "abierto").order("iniciado_at", { ascending: false }).limit(1);
    const conteo = (cs && cs[0]) as Conteo | undefined;
    setConteoAbierto(conteo ?? null);
    if (conteo) {
      const { data: ls } = await db.from("stock_conteo_lineas")
        .select("id, insumo_id, stock_teorico, stock_contado, diferencia, insumos(nombre, unidad)")
        .eq("conteo_id", conteo.id).order("id");
      type LR = ConteoLinea & { insumos?: { nombre: string; unidad: string } | { nombre: string; unidad: string }[] | null };
      const pl = ((ls || []) as unknown as LR[]).map(l => {
        const ins = Array.isArray(l.insumos) ? l.insumos[0] : l.insumos;
        return { ...l, insumo_nombre: ins?.nombre, insumo_unidad: ins?.unidad };
      });
      setLineas(pl);
      const edits: Record<number, string> = {};
      for (const l of pl) if (l.stock_contado != null) edits[l.insumo_id] = String(l.stock_contado);
      setContadoEdits(edits);
    } else { setLineas([]); setContadoEdits({}); }
  }, [localActivo]);

  const cargarHistorial = useCallback(async () => {
    if (!localActivo) { setConteos([]); return; }
    const { data } = await db.from("stock_conteos")
      .select("id, local_id, estado, notas, iniciado_at, finalizado_at, total_insumos, total_ajustes, valor_diferencia")
      .eq("local_id", localActivo).order("iniciado_at", { ascending: false }).limit(50);
    setConteos((data || []) as Conteo[]);
  }, [localActivo]);

  useEffect(() => { void cargarBase(); }, [cargarBase]);
  useEffect(() => { void cargarConteoAbierto(); void cargarHistorial(); }, [cargarConteoAbierto, cargarHistorial]);

  // ── Conteo: iniciar / cargar línea / finalizar ──
  const { run: iniciarConteo, isPending: iniciando } = useGuardedHandler(async () => {
    if (!localActivo) { showError("Elegí un local primero"); return; }
    const { error } = await db.rpc("fn_iniciar_conteo_fisico", { p_local_id: localActivo, p_notas: null });
    if (error) { showError("No se pudo iniciar el conteo: " + translateRpcError(error)); return; }
    setConteoFinalizado(null);
    await cargarConteoAbierto();
    showToast("Conteo iniciado — cargá lo que contás (a ciegas)");
  });

  const { run: guardarLineas, isPending: guardandoLineas } = useGuardedHandler(async () => {
    if (!conteoAbierto) return;
    // Persistir cada contado tipeado.
    for (const l of lineas) {
      const v = contadoEdits[l.insumo_id];
      if (v === undefined || v === "") continue;
      const num = parseFloat(v);
      if (isNaN(num) || num < 0) continue;
      const { error } = await db.rpc("fn_cargar_conteo_linea", { p_conteo_id: conteoAbierto.id, p_insumo_id: l.insumo_id, p_stock_contado: num, p_notas: null });
      if (error) { showError(`Error guardando ${l.insumo_nombre}: ${translateRpcError(error)}`); return; }
    }
    showToast("Conteo guardado");
    await cargarConteoAbierto();
  });

  const { run: finalizarConteo, isPending: finalizando } = useGuardedHandler(async () => {
    if (!conteoAbierto) return;
    if (!confirm("¿Finalizar el conteo? Se van a aplicar los ajustes y vas a ver la diferencia real.")) return;
    // Guardar lo pendiente antes de cerrar.
    for (const l of lineas) {
      const v = contadoEdits[l.insumo_id];
      if (v === undefined || v === "") continue;
      const num = parseFloat(v);
      if (!isNaN(num) && num >= 0) {
        await db.rpc("fn_cargar_conteo_linea", { p_conteo_id: conteoAbierto.id, p_insumo_id: l.insumo_id, p_stock_contado: num, p_notas: null });
      }
    }
    const { error } = await db.rpc("fn_finalizar_conteo_fisico", { p_conteo_id: conteoAbierto.id });
    if (error) { showError("No se pudo finalizar: " + translateRpcError(error)); return; }
    // Revelar resultado.
    const cerradoId = conteoAbierto.id;
    await cargarConteoAbierto();
    await cargarHistorial();
    await cargarBase();
    const { data: cer } = await db.from("stock_conteos").select("id, local_id, estado, notas, iniciado_at, finalizado_at, total_insumos, total_ajustes, valor_diferencia").eq("id", cerradoId).single();
    if (cer) { setConteoFinalizado(cer as Conteo); await verDetalle(cer as Conteo); }
    showToast("Conteo finalizado — diferencias reveladas");
  });

  // ── Mermas ──
  const { run: registrarMerma, isPending: registrandoMerma } = useGuardedHandler(async () => {
    if (!localActivo) { showError("Elegí un local primero"); return; }
    if (!mermaForm.insumo_id) { showError("Elegí el insumo"); return; }
    if (!mermaForm.motivo_id) { showError("Elegí el motivo"); return; }
    const cant = parseFloat(mermaForm.cantidad);
    if (isNaN(cant) || cant <= 0) { showError("Cantidad inválida"); return; }
    const { error } = await db.rpc("fn_registrar_merma", {
      p_insumo_id: parseInt(mermaForm.insumo_id), p_local_id: localActivo,
      p_cantidad: cant, p_motivo_id: parseInt(mermaForm.motivo_id),
      p_notas: mermaForm.notas.trim() || null,
    });
    if (error) { showError("No se pudo registrar la merma: " + translateRpcError(error)); return; }
    showToast("Merma registrada");
    setMermaModal(false);
    setMermaForm({ insumo_id: "", cantidad: "", motivo_id: "", notas: "" });
    await cargarBase();
  });

  // ── Render ──
  const insumosFiltrados = insumos.filter(i => !search || i.nombre.toLowerCase().includes(search.toLowerCase()));
  const valorStock = insumos.reduce((s, i) => s + stockVisible(i, localActivo) * Number(i.costo_actual ?? 0), 0);
  const bajoMinimo = insumos.filter(i => i.stock_minimo != null && stockVisible(i, localActivo) < Number(i.stock_minimo)).length;

  const sinLocal = !localActivo;

  return (
    <div>
      <ToastComponent toast={toast} />
      {!embedded && (
        <div className="ph-row">
          <div>
            <div className="ph-title">Stock</div>
            <div style={{ color: "var(--muted2)", fontSize: 12, marginTop: 2 }}>
              Valor en stock {fmt_$(valorStock)}{bajoMinimo > 0 && <> · <span style={{ color: "var(--warn)" }}>{bajoMinimo} bajo mínimo</span></>}
            </div>
          </div>
        </div>
      )}

      {/* Sub-nav interno */}
      <div className="panel" style={{ marginBottom: 8 }}>
        <div style={{ padding: "8px 12px", display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          {(["stock", "conteo", "mermas", "historial"] as Vista[]).map(v => (
            <button key={v} className={`btn btn-sm ${vista === v ? "btn-acc" : "btn-ghost"}`} onClick={() => setVista(v)}>
              {v === "stock" ? "Stock actual" : v === "conteo" ? "Conteo" : v === "mermas" ? "Mermas" : "Historial"}
            </button>
          ))}
          {vista === "stock" && <input type="text" placeholder="Buscar insumo…" value={search} onChange={e => setSearch(e.target.value)} className="search" style={{ marginLeft: "auto", width: 200 }} />}
          {vista === "mermas" && puede && <button className="btn btn-acc btn-sm" style={{ marginLeft: "auto" }} onClick={() => setMermaModal(true)} disabled={sinLocal}>+ Registrar merma</button>}
        </div>
      </div>

      {sinLocal && (vista === "conteo" || vista === "mermas" || vista === "historial") && (
        <div className="panel"><div className="empty" style={{ padding: 30 }}>Elegí un local (arriba a la izquierda) para operar el stock de esa sucursal.</div></div>
      )}

      {/* ── STOCK ACTUAL ── */}
      {vista === "stock" && (
        <div className="panel">
          {loading ? <div className="loading" style={{ padding: 40 }}>Cargando…</div> : insumosFiltrados.length === 0 ? (
            <div className="empty" style={{ padding: 40 }}>No hay insumos.</div>
          ) : (
            <table>
              <thead><tr><th></th><th>Insumo</th><th style={{ textAlign: "right" }}>Stock</th><th style={{ textAlign: "right" }}>Mínimo</th><th style={{ textAlign: "right" }}>Costo unit.</th><th style={{ textAlign: "right" }}>Valor</th></tr></thead>
              <tbody>
                {insumosFiltrados.map(i => {
                  const stk = stockVisible(i, localActivo);
                  const agotado = stk <= 0;
                  const bajo = !agotado && i.stock_minimo != null && stk < Number(i.stock_minimo);
                  return (
                    <tr key={i.id}>
                      <td style={{ width: 26, fontSize: 16 }}>{i.emoji ?? "📦"}</td>
                      <td style={{ fontWeight: 500 }}>{i.nombre}</td>
                      <td className="mono" style={{ textAlign: "right", color: agotado || bajo ? "var(--danger)" : undefined }}>
                        {stk.toFixed(2)} {i.unidad}
                        {agotado && <span className="badge b-danger" style={{ fontSize: 9, marginLeft: 4 }}>Agotado</span>}
                        {bajo && <span className="badge b-danger" style={{ fontSize: 9, marginLeft: 4 }}>bajo</span>}
                      </td>
                      <td className="mono" style={{ textAlign: "right", color: "var(--muted2)" }}>{i.stock_minimo != null ? Number(i.stock_minimo).toFixed(0) : "—"}</td>
                      <td className="mono" style={{ textAlign: "right", color: "var(--muted2)" }}>{i.costo_actual ? fmt_$(Number(i.costo_actual)) : "—"}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{fmt_$(stk * Number(i.costo_actual ?? 0))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── CONTEO CIEGO ── */}
      {vista === "conteo" && !sinLocal && (
        <div className="panel" style={{ padding: 14 }}>
          {!conteoAbierto ? (
            <div style={{ textAlign: "center", padding: 20 }}>
              <div style={{ fontSize: 13, color: "var(--muted2)", marginBottom: 12 }}>
                No hay un conteo abierto. Al iniciar, vas a cargar lo que contás <strong>sin ver el stock teórico</strong> — así la diferencia es real.
              </div>
              {puede && <button className="btn btn-acc" onClick={() => iniciarConteo()} disabled={iniciando}>{iniciando ? "Iniciando…" : "Iniciar conteo ciego"}</button>}
              {conteoFinalizado && (
                <div style={{ marginTop: 16, fontSize: 12 }}>
                  <span className="badge b-success">Último conteo finalizado</span> diferencia {fmt_$(Number(conteoFinalizado.valor_diferencia ?? 0))} ·
                  <button className="btn btn-ghost btn-sm" onClick={() => void verDetalle(conteoFinalizado)}>ver detalle</button>
                </div>
              )}
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                <div style={{ fontSize: 12 }}>
                  <span className="badge b-warn">Conteo en curso (ciego)</span> iniciado {fmtDt(conteoAbierto.iniciado_at)} · {lineas.length} insumos
                </div>
                {puede && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-sec btn-sm" onClick={() => guardarLineas()} disabled={guardandoLineas}>Guardar avance</button>
                    <button className="btn btn-acc btn-sm" onClick={() => finalizarConteo()} disabled={finalizando}>{finalizando ? "Finalizando…" : "Finalizar + ver diferencia"}</button>
                  </div>
                )}
              </div>
              <table>
                <thead><tr><th>Insumo</th><th style={{ width: 160, textAlign: "right" }}>Contado</th></tr></thead>
                <tbody>
                  {lineas.map(l => (
                    <tr key={l.id}>
                      <td>{l.insumo_nombre} <span style={{ color: "var(--muted2)", fontSize: 11 }}>({l.insumo_unidad})</span></td>
                      <td>
                        <input type="number" step="0.01" min="0" placeholder="—"
                          value={contadoEdits[l.insumo_id] ?? ""}
                          onChange={e => setContadoEdits({ ...contadoEdits, [l.insumo_id]: e.target.value })}
                          className="search mono" style={{ width: "100%", textAlign: "right" }} disabled={!puede} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 6 }}>Cargá lo que contaste físicamente. No ves el teórico a propósito: así, al finalizar, la diferencia es honesta.</div>
            </div>
          )}
        </div>
      )}

      {/* ── MERMAS ── */}
      {vista === "mermas" && !sinLocal && (
        <div className="panel"><div className="empty" style={{ padding: 30, fontSize: 12 }}>Registrá mermas/desperdicios con el botón de arriba. Cada merma descuenta del stock con su motivo (vencido, derramado, quemado, etc.).</div></div>
      )}

      {/* ── HISTORIAL ── */}
      {vista === "historial" && !sinLocal && (
        <div className="panel">
          {conteos.length === 0 ? <div className="empty" style={{ padding: 30 }}>Todavía no hay conteos.</div> : (
            <table>
              <thead><tr><th>Fecha</th><th>Estado</th><th style={{ textAlign: "right" }}>Insumos</th><th style={{ textAlign: "right" }}>Ajustes</th><th style={{ textAlign: "right" }}>Dif. $</th><th></th></tr></thead>
              <tbody>
                {conteos.map(c => (
                  <tr key={c.id}>
                    <td className="mono" style={{ fontSize: 11 }}>{fmtDt(c.iniciado_at)}</td>
                    <td>{c.estado === "abierto" ? <span className="badge b-warn" style={{ fontSize: 10 }}>abierto</span> : <span className="badge b-muted" style={{ fontSize: 10 }}>finalizado</span>}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{c.total_insumos ?? "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{c.total_ajustes ?? "—"}</td>
                    <td className="mono" style={{ textAlign: "right", color: Number(c.valor_diferencia ?? 0) < 0 ? "var(--danger)" : undefined }}>{c.valor_diferencia != null ? fmt_$(Number(c.valor_diferencia)) : "—"}</td>
                    <td style={{ textAlign: "right" }}><button className="btn btn-ghost btn-sm" onClick={() => void verDetalle(c)}>Detalle</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Modal merma */}
      <Modal isOpen={mermaModal} onClose={() => setMermaModal(false)} title="Registrar merma" maxWidth={460}
        footer={<><button className="btn btn-sec" onClick={() => setMermaModal(false)} disabled={registrandoMerma}>Cancelar</button><button className="btn btn-acc" onClick={() => registrarMerma()} disabled={registrandoMerma}>{registrandoMerma ? "Registrando…" : "Registrar"}</button></>}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: "var(--muted2)" }}>Insumo</label>
            <select value={mermaForm.insumo_id} onChange={e => setMermaForm({ ...mermaForm, insumo_id: e.target.value })} className="search" style={{ width: "100%" }}>
              <option value="">Elegí…</option>
              {insumos.map(i => <option key={i.id} value={String(i.id)}>{i.nombre} ({i.unidad}) · stock {stockVisible(i, localActivo).toFixed(2)}</option>)}
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={{ fontSize: 11, color: "var(--muted2)" }}>Cantidad</label>
              <input type="number" step="0.01" min="0" value={mermaForm.cantidad} onChange={e => setMermaForm({ ...mermaForm, cantidad: e.target.value })} className="search" style={{ width: "100%" }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: "var(--muted2)" }}>Motivo</label>
              <select value={mermaForm.motivo_id} onChange={e => setMermaForm({ ...mermaForm, motivo_id: e.target.value })} className="search" style={{ width: "100%" }}>
                <option value="">Elegí…</option>
                {motivos.map(m => <option key={m.id} value={String(m.id)}>{m.emoji ? `${m.emoji} ` : ""}{m.nombre}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--muted2)" }}>Notas (opcional)</label>
            <input type="text" value={mermaForm.notas} onChange={e => setMermaForm({ ...mermaForm, notas: e.target.value })} className="search" style={{ width: "100%" }} />
          </div>
        </div>
      </Modal>

      {/* Modal detalle conteo (diferencias reveladas) */}
      <Modal isOpen={!!detalleConteo} onClose={() => setDetalleConteo(null)} title={detalleConteo ? `Conteo ${fmtDt(detalleConteo.conteo.iniciado_at)}` : ""} maxWidth={640}>
        {detalleConteo && (
          <div>
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              Diferencia total: <strong style={{ color: Number(detalleConteo.conteo.valor_diferencia ?? 0) < 0 ? "var(--danger)" : "var(--text)" }}>{fmt_$(Number(detalleConteo.conteo.valor_diferencia ?? 0))}</strong>
              {" · "}{detalleConteo.conteo.total_ajustes ?? 0} ajustes
            </div>
            <table>
              <thead><tr><th>Insumo</th><th style={{ textAlign: "right" }}>Teórico</th><th style={{ textAlign: "right" }}>Contado</th><th style={{ textAlign: "right" }}>Diferencia</th></tr></thead>
              <tbody>
                {detalleConteo.lineas.map(l => {
                  const dif = Number(l.diferencia ?? 0);
                  return (
                    <tr key={l.id}>
                      <td>{l.insumo_nombre}</td>
                      <td className="mono" style={{ textAlign: "right", color: "var(--muted2)" }}>{l.stock_teorico != null ? Number(l.stock_teorico).toFixed(2) : "—"}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{l.stock_contado != null ? Number(l.stock_contado).toFixed(2) : "—"}</td>
                      <td className="mono" style={{ textAlign: "right", color: dif < 0 ? "var(--danger)" : dif > 0 ? "var(--success)" : "var(--muted2)" }}>{dif !== 0 ? dif.toFixed(2) : "0"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 6 }}>Diferencia negativa = falta stock (merma no cargada, robo, receta mal calibrada). Positiva = sobra.</div>
          </div>
        )}
      </Modal>
    </div>
  );
}
