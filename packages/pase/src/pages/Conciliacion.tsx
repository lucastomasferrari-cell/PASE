// ─── CONCILIACIÓN DE COMPRAS ──────────────────────────────────────────────
// Bandeja conciliadora (Pieza A del circuito CMV). Spec:
//   docs/superpowers/specs/2026-06-07-bandeja-conciliacion-compras-insumos-design.md
//
// Acumula los renglones de mercadería (categoría CMV) de las facturas
// (manual + IA) que el sistema no pudo vincular solo a una materia prima.
// Los resolvés acá una vez; el sistema aprende el mapeo (compras_mapeo) y la
// próxima factura con ese producto se auto-vincula. Al resolver, el trigger
// de stock suma el insumo y se actualiza el costo.
//
// Backend: vista v_bandeja_conciliacion + fn_conciliar_producto +
// fn_descartar_renglon (migración 202606071500).

import { useState, useEffect, useMemo } from "react";
import { db } from "../lib/supabase";
import { tienePermiso } from "../lib/auth";
import { useGuardedHandler } from "../lib/useGuardedHandler";
import { translateRpcError } from "../lib/errors";
import { fmt_$ } from "@pase/shared/utils";
import type { Usuario, Local } from "../types/auth";
import { Modal } from "../components/ui";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";

const UNIDADES_COMPRA = [
  "bolsa", "caja", "kg", "g", "L", "ml", "un", "docena", "paquete", "atado", "bandeja", "rollo",
];

interface BandejaRow {
  factura_item_id: number;
  factura_id: string;
  producto: string;
  cantidad: number;
  unidad: string;
  precio_unitario: number | null;
  subtotal: number | null;
  proveedor_id: number | null;
  proveedor_nombre: string | null;
  factura_fecha: string;
  local_id: number;
  categoria: string;
  grupo_categoria: string | null;
  texto_norm: string;
  sugerencia_mp_id: number | null;
}

interface MateriaPrima { id: number; nombre: string; proveedor_id: number | null; insumo_id: number; }
interface Insumo { id: number; nombre: string; unidad: string; }

// Grupo "por producto": dedup por texto normalizado + proveedor.
interface Grupo {
  key: string;
  producto: string;
  texto_norm: string;
  proveedor_id: number | null;
  proveedor_nombre: string | null;
  sugerencia_mp_id: number | null;
  facturaItemIds: number[];
  nFacturas: number;
  ultimoPrecio: number | null;
}

interface ConciliacionProps {
  user: Usuario;
  locales?: Local[];
  localActivo: number | null;
  embedded?: boolean;
}

const fmtFecha = (s: string) => new Date(s).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });

export default function Conciliacion({ user, embedded = false }: ConciliacionProps) {
  const { toast, showError, showToast } = useToast();
  const [rows, setRows] = useState<BandejaRow[]>([]);
  const [mps, setMps] = useState<MateriaPrima[]>([]);
  const [insumos, setInsumos] = useState<Insumo[]>([]);
  const [loading, setLoading] = useState(true);
  const [vista, setVista] = useState<"producto" | "factura">("producto");
  const [search, setSearch] = useState("");

  // Modal de resolución (de un grupo / producto)
  const [resolver, setResolver] = useState<Grupo | null>(null);
  // Sub-form del modal
  const [modo, setModo] = useState<"existente" | "nueva">("nueva");
  const [mpSel, setMpSel] = useState<string>("");
  const [global, setGlobal] = useState(false);
  const [nueva, setNueva] = useState({
    nombre: "", insumo_id: "", unidad_compra: "caja", factor_conversion: "1", merma_pct: "0", precio_actual: "",
  });
  // Quick create insumo
  const [quickInsumoOpen, setQuickInsumoOpen] = useState(false);
  const [quickInsumoForm, setQuickInsumoForm] = useState({ nombre: "", unidad: "kg" });

  const puede = tienePermiso(user, "compras") || user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin";

  const load = async () => {
    setLoading(true);
    const [bRes, mpRes, insRes] = await Promise.all([
      db.from("v_bandeja_conciliacion")
        .select("factura_item_id, factura_id, producto, cantidad, unidad, precio_unitario, subtotal, proveedor_id, proveedor_nombre, factura_fecha, local_id, categoria, grupo_categoria, texto_norm, sugerencia_mp_id")
        .eq("grupo_categoria", "CMV")
        .order("factura_fecha", { ascending: false })
        .limit(2000),
      db.from("materias_primas").select("id, nombre, proveedor_id, insumo_id").is("deleted_at", null).eq("activa", true).order("nombre"),
      db.from("insumos").select("id, nombre, unidad").eq("activo", true).is("deleted_at", null).order("nombre"),
    ]);
    if (bRes.error) { showError("No se pudo cargar la bandeja: " + bRes.error.message); setLoading(false); return; }
    setRows((bRes.data || []) as BandejaRow[]);
    setMps((mpRes.data || []) as MateriaPrima[]);
    setInsumos((insRes.data || []) as Insumo[]);
    setLoading(false);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Agrupado por producto (dedup texto_norm + proveedor)
  const grupos: Grupo[] = useMemo(() => {
    const map = new Map<string, Grupo & { facturas: Set<string> }>();
    for (const r of rows) {
      const key = `${r.texto_norm}||${r.proveedor_id ?? "x"}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key, producto: r.producto, texto_norm: r.texto_norm,
          proveedor_id: r.proveedor_id, proveedor_nombre: r.proveedor_nombre,
          sugerencia_mp_id: r.sugerencia_mp_id,
          facturaItemIds: [], nFacturas: 0, ultimoPrecio: r.precio_unitario != null ? Number(r.precio_unitario) : null,
          facturas: new Set<string>(),
        };
        map.set(key, g);
      }
      g.facturaItemIds.push(r.factura_item_id);
      g.facturas.add(r.factura_id);
    }
    return [...map.values()]
      .map(g => ({ ...g, nFacturas: g.facturas.size }))
      .filter(g => !search || g.producto.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => a.producto.localeCompare(b.producto));
  }, [rows, search]);

  // Agrupado por factura
  const porFactura = useMemo(() => {
    const map = new Map<string, { factura_id: string; fecha: string; proveedor: string | null; items: BandejaRow[] }>();
    for (const r of rows) {
      if (search && !r.producto.toLowerCase().includes(search.toLowerCase())) continue;
      let f = map.get(r.factura_id);
      if (!f) { f = { factura_id: r.factura_id, fecha: r.factura_fecha, proveedor: r.proveedor_nombre, items: [] }; map.set(r.factura_id, f); }
      f.items.push(r);
    }
    return [...map.values()].sort((a, b) => b.fecha.localeCompare(a.fecha));
  }, [rows, search]);

  const insById = useMemo(() => { const m = new Map<number, Insumo>(); insumos.forEach(i => m.set(i.id, i)); return m; }, [insumos]);
  const mpById = useMemo(() => { const m = new Map<number, MateriaPrima>(); mps.forEach(p => m.set(p.id, p)); return m; }, [mps]);

  const abrirResolver = (g: Grupo) => {
    setResolver(g);
    setGlobal(false);
    if (g.sugerencia_mp_id) { setModo("existente"); setMpSel(String(g.sugerencia_mp_id)); }
    else { setModo("nueva"); setMpSel(""); }
    setNueva({
      nombre: g.producto, insumo_id: insumos[0] ? String(insumos[0].id) : "",
      unidad_compra: "caja", factor_conversion: "1", merma_pct: "0",
      precio_actual: g.ultimoPrecio != null ? String(g.ultimoPrecio) : "",
    });
  };

  // MPs candidatas para vincular (del proveedor del grupo + las globales sin proveedor)
  const mpsCandidatas = useMemo(() => {
    if (!resolver) return [];
    return mps.filter(p => p.proveedor_id === resolver.proveedor_id || p.proveedor_id === null);
  }, [mps, resolver]);

  const { run: conciliar, isPending: conciliando } = useGuardedHandler(async () => {
    if (!resolver) return;
    let mpId: number | null = null;

    if (modo === "existente") {
      if (!mpSel) { showError("Elegí una materia prima o creá una nueva"); return; }
      mpId = parseInt(mpSel);
    } else {
      // crear materia prima nueva
      if (!nueva.nombre.trim()) { showError("Ponele un nombre a la materia prima"); return; }
      if (!nueva.insumo_id) { showError("Elegí o creá un insumo"); return; }
      const factor = parseFloat(nueva.factor_conversion);
      if (!factor || factor <= 0) { showError("El factor debe ser > 0"); return; }
      const { data, error } = await db.from("materias_primas").insert([{
        tenant_id: user.tenant_id, created_by: user.id,
        nombre: nueva.nombre.trim(),
        proveedor_id: resolver.proveedor_id,
        insumo_id: parseInt(nueva.insumo_id),
        unidad_compra: nueva.unidad_compra,
        factor_conversion: factor,
        merma_pct: parseFloat(nueva.merma_pct) || 0,
        precio_actual: nueva.precio_actual ? parseFloat(nueva.precio_actual) : null,
        activa: true,
        ...(nueva.precio_actual ? { precio_actualizado_at: new Date().toISOString() } : {}),
      }]).select("id").single();
      if (error || !data) { showError("No se pudo crear la materia prima: " + (error?.message ?? "vacío")); return; }
      mpId = data.id as number;
    }

    const { data: res, error: cErr } = await db.rpc("fn_conciliar_producto", {
      p_materia_prima_id: mpId,
      p_producto: resolver.producto,
      p_proveedor_id: resolver.proveedor_id,
      p_global: global,
      p_idempotency_key: null,
    });
    if (cErr) { showError("No se pudo conciliar: " + translateRpcError(cErr)); return; }
    const n = (res as { renglones_vinculados?: number })?.renglones_vinculados ?? 0;
    showToast(`Producto conciliado · ${n} renglón${n === 1 ? "" : "es"} vinculado${n === 1 ? "" : "s"}`);
    setResolver(null);
    await load();
  });

  const { run: descartarGrupo, isPending: descartando } = useGuardedHandler(async (g: Grupo) => {
    if (!confirm(`Descartar "${g.producto}"? No es un insumo (flete, propina, etc.) y no volverá a la bandeja.`)) return;
    for (const id of g.facturaItemIds) {
      const { error } = await db.rpc("fn_descartar_renglon", { p_factura_item_id: id, p_descartar: true });
      if (error) { showError("No se pudo descartar: " + translateRpcError(error)); return; }
    }
    showToast("Descartado");
    await load();
  });

  const { run: crearInsumoQuick, isPending: creandoInsumo } = useGuardedHandler(async () => {
    if (!quickInsumoForm.nombre.trim()) { showError("Ponele un nombre al insumo"); return; }
    const { data, error } = await db.from("insumos").insert([{
      tenant_id: user.tenant_id, created_by: user.id,
      nombre: quickInsumoForm.nombre.trim(), unidad: quickInsumoForm.unidad,
      activo: true, es_comprado: true, stock_disponible: true,
    }]).select("id").single();
    if (error || !data) { showError("No se pudo crear el insumo: " + (error?.message ?? "vacío")); return; }
    const { data: nuevos } = await db.from("insumos").select("id, nombre, unidad").eq("activo", true).is("deleted_at", null).order("nombre");
    setInsumos((nuevos || []) as Insumo[]);
    setNueva(n => ({ ...n, insumo_id: String(data.id) }));
    setQuickInsumoOpen(false);
    setQuickInsumoForm({ nombre: "", unidad: "kg" });
    showToast("Insumo creado");
  });

  const totalPendientes = rows.length;
  const totalProductos = grupos.length;

  return (
    <div>
      <ToastComponent toast={toast} />
      {!embedded && (
        <div className="ph-row">
          <div>
            <div className="ph-title">Conciliación de compras</div>
            <div style={{ color: "var(--muted2)", fontSize: 12, marginTop: 2 }}>
              Productos de facturas sin vincular a una materia prima · {totalProductos} productos / {totalPendientes} renglones
            </div>
          </div>
        </div>
      )}

      {/* Banner explicativo */}
      {rows.length === 0 && !loading && (
        <div style={{ marginBottom: 12, padding: "12px 14px", background: "rgba(34,197,94,0.08)", border: "0.5px solid rgba(34,197,94,0.3)", borderRadius: 6, fontSize: 12, color: "var(--muted2)" }}>
          <strong style={{ color: "var(--success)" }}>✓ Bandeja vacía.</strong> No hay productos de mercadería pendientes de vincular. Cuando cargues facturas (a mano o por el Lector IA), los productos nuevos van a aparecer acá para que los mapees una vez.
        </div>
      )}

      {/* Toolbar */}
      {rows.length > 0 && (
        <div className="panel" style={{ marginBottom: 8 }}>
          <div style={{ padding: "10px 14px", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <div style={{ display: "flex", gap: 4, background: "var(--s2)", borderRadius: 6, padding: 3 }}>
              <button className={`btn btn-sm ${vista === "producto" ? "btn-acc" : "btn-ghost"}`} onClick={() => setVista("producto")}>Por producto</button>
              <button className={`btn btn-sm ${vista === "factura" ? "btn-acc" : "btn-ghost"}`} onClick={() => setVista("factura")}>Por factura</button>
            </div>
            <input type="text" placeholder="Buscar producto…" value={search} onChange={e => setSearch(e.target.value)} className="search" style={{ flex: 1, minWidth: 180 }} />
            <span style={{ fontSize: 11, color: "var(--muted2)" }}>{totalProductos} productos · {totalPendientes} renglones</span>
          </div>
        </div>
      )}

      {/* Contenido */}
      <div className="panel">
        {loading ? (
          <div className="loading" style={{ padding: 40 }}>Cargando bandeja…</div>
        ) : rows.length === 0 ? (
          <div className="empty" style={{ padding: 40 }}>Sin pendientes 🎉</div>
        ) : vista === "producto" ? (
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th>Proveedor</th>
                <th style={{ textAlign: "right" }}>En facturas</th>
                <th style={{ textAlign: "right" }}>Último precio</th>
                <th style={{ width: 180 }}></th>
              </tr>
            </thead>
            <tbody>
              {grupos.map(g => {
                const sug = g.sugerencia_mp_id ? mpById.get(g.sugerencia_mp_id) : null;
                return (
                  <tr key={g.key}>
                    <td style={{ fontWeight: 500 }}>
                      {g.producto}
                      {sug && <span className="badge b-success" style={{ fontSize: 9, marginLeft: 6 }}>≈ {sug.nombre}</span>}
                    </td>
                    <td style={{ fontSize: 12 }}>{g.proveedor_nombre || <span className="badge b-warn" style={{ fontSize: 10 }}>Sin prov.</span>}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{g.nFacturas}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{g.ultimoPrecio != null ? fmt_$(g.ultimoPrecio) : "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      {puede && (
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                          <button className="btn btn-acc btn-sm" onClick={() => abrirResolver(g)}>Resolver</button>
                          <button className="btn btn-ghost btn-sm" disabled={descartando} onClick={() => descartarGrupo(g)}>Descartar</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {porFactura.map(f => (
              <div key={f.factura_id} style={{ borderBottom: "0.5px solid var(--bd)", padding: "10px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>
                    📄 {f.proveedor || "Sin proveedor"} · {fmtFecha(f.fecha)}
                    <span style={{ color: "var(--warn)", fontWeight: 400, marginLeft: 8 }}>{f.items.length} sin vincular</span>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {f.items.map(it => {
                    const g = grupos.find(gg => gg.facturaItemIds.includes(it.factura_item_id))
                      || { key: it.texto_norm, producto: it.producto, texto_norm: it.texto_norm, proveedor_id: it.proveedor_id, proveedor_nombre: it.proveedor_nombre, sugerencia_mp_id: it.sugerencia_mp_id, facturaItemIds: [it.factura_item_id], nFacturas: 1, ultimoPrecio: it.precio_unitario != null ? Number(it.precio_unitario) : null } as Grupo;
                    return (
                      <div key={it.factura_item_id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}>
                        <span>{it.producto} <span style={{ color: "var(--muted2)" }}>· {Number(it.cantidad)} {it.unidad}</span></span>
                        {puede && (
                          <div style={{ display: "flex", gap: 4 }}>
                            <button className="btn btn-acc btn-sm" onClick={() => abrirResolver(g)}>Resolver</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modal de resolución */}
      <Modal
        isOpen={!!resolver}
        onClose={() => setResolver(null)}
        title={resolver ? `Resolver: ${resolver.producto}` : ""}
        maxWidth={560}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setResolver(null)} disabled={conciliando}>Cancelar</button>
            <button className="btn btn-acc" onClick={() => conciliar()} disabled={conciliando}>
              {conciliando ? "Guardando…" : "Conciliar y vincular"}
            </button>
          </>
        }
      >
        {resolver && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 11, color: "var(--muted2)" }}>
              Proveedor: <strong>{resolver.proveedor_nombre || "—"}</strong> · aparece en <strong>{resolver.nFacturas}</strong> factura{resolver.nFacturas === 1 ? "" : "s"}.
              Al conciliar, se vinculan todas y el sistema lo recuerda para la próxima.
            </div>

            {/* Selector de modo */}
            <div style={{ display: "flex", gap: 4, background: "var(--s2)", borderRadius: 6, padding: 3 }}>
              <button className={`btn btn-sm ${modo === "nueva" ? "btn-acc" : "btn-ghost"}`} onClick={() => setModo("nueva")}>Crear materia prima</button>
              <button className={`btn btn-sm ${modo === "existente" ? "btn-acc" : "btn-ghost"}`} onClick={() => setModo("existente")} disabled={mpsCandidatas.length === 0}>Vincular a existente</button>
            </div>

            {modo === "existente" ? (
              <div>
                <label style={{ fontSize: 11, color: "var(--muted2)" }}>Materia prima existente</label>
                <select value={mpSel} onChange={e => setMpSel(e.target.value)} className="search" style={{ width: "100%" }}>
                  <option value="">Elegí una…</option>
                  {mpsCandidatas.map(p => {
                    const ins = insById.get(p.insumo_id);
                    return <option key={p.id} value={String(p.id)}>{p.nombre}{ins ? ` → ${ins.nombre}` : ""}</option>;
                  })}
                </select>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 11, color: "var(--muted2)" }}>Nombre de la materia prima</label>
                  <input type="text" value={nueva.nombre} onChange={e => setNueva({ ...nueva, nombre: e.target.value })} className="search" style={{ width: "100%" }} />
                </div>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <label style={{ fontSize: 11, color: "var(--muted2)" }}>Es el insumo (lo que usás en recetas) *</label>
                    <button type="button" onClick={() => { setQuickInsumoForm({ nombre: nueva.nombre, unidad: "kg" }); setQuickInsumoOpen(true); }} style={{ fontSize: 10, color: "var(--acc)", background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}>+ Crear insumo</button>
                  </div>
                  <select value={nueva.insumo_id} onChange={e => setNueva({ ...nueva, insumo_id: e.target.value })} className="search" style={{ width: "100%" }}>
                    <option value="">Seleccionar insumo…</option>
                    {insumos.map(i => <option key={i.id} value={String(i.id)}>{i.nombre} ({i.unidad})</option>)}
                  </select>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <div>
                    <label style={{ fontSize: 11, color: "var(--muted2)" }}>Viene en</label>
                    <input type="text" list="uc-list" value={nueva.unidad_compra} onChange={e => setNueva({ ...nueva, unidad_compra: e.target.value })} className="search" style={{ width: "100%" }} />
                    <datalist id="uc-list">{UNIDADES_COMPRA.map(u => <option key={u} value={u} />)}</datalist>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "var(--muted2)" }}>Cantidad</label>
                    <input type="number" step="0.01" min="0.01" value={nueva.factor_conversion} onChange={e => setNueva({ ...nueva, factor_conversion: e.target.value })} className="search" style={{ width: "100%" }} />
                    <div style={{ fontSize: 9, color: "var(--muted2)", marginTop: 2 }}>
                      {(() => { const ins = insById.get(parseInt(nueva.insumo_id)); return ins ? `${ins.unidad} por ${nueva.unidad_compra || "unidad"}` : "por unidad de compra"; })()}
                    </div>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "var(--muted2)" }}>Precio</label>
                    <input type="number" step="0.01" value={nueva.precio_actual} onChange={e => setNueva({ ...nueva, precio_actual: e.target.value })} className="search" style={{ width: "100%" }} />
                  </div>
                </div>
              </div>
            )}

            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: 8, background: "var(--s2)", borderRadius: 4 }}>
              <input type="checkbox" checked={global} onChange={e => setGlobal(e.target.checked)} />
              Este mapeo vale para cualquier proveedor (no solo {resolver.proveedor_nombre || "este"})
            </label>
          </div>
        )}
      </Modal>

      {/* Mini-modal crear insumo */}
      <Modal
        isOpen={quickInsumoOpen}
        onClose={() => setQuickInsumoOpen(false)}
        title="Crear insumo rápido"
        maxWidth={420}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setQuickInsumoOpen(false)} disabled={creandoInsumo}>Cancelar</button>
            <button className="btn btn-acc" onClick={() => crearInsumoQuick()} disabled={creandoInsumo}>{creandoInsumo ? "Creando…" : "Crear"}</button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 11, color: "var(--muted2)" }}>
            El insumo es lo que usás en las recetas, ya listo para usar (ej: "Trucha fileteada", "Palta"). El rendimiento (merma) lo cargás después en Insumos.
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--muted2)" }}>Nombre *</label>
            <input type="text" value={quickInsumoForm.nombre} onChange={e => setQuickInsumoForm({ ...quickInsumoForm, nombre: e.target.value })} className="search" style={{ width: "100%" }} autoFocus />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--muted2)" }}>Unidad base *</label>
            <select value={quickInsumoForm.unidad} onChange={e => setQuickInsumoForm({ ...quickInsumoForm, unidad: e.target.value })} className="search" style={{ width: "100%" }}>
              <option value="kg">kg</option><option value="g">g</option><option value="L">L</option><option value="ml">ml</option><option value="un">un</option><option value="docena">docena</option>
            </select>
          </div>
        </div>
      </Modal>
    </div>
  );
}
