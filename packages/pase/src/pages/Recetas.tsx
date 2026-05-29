// ─── RECETAS ──────────────────────────────────────────────────────────────
// Catálogo de recetas: vincula items (productos vendibles) con sus insumos
// (materia prima) para calcular CMV teórico y margen.
//
// Modelo:
//   - 1 item puede tener máx 1 receta activa (constraint UNIQUE)
//   - recetas.item_id → items.id (FK)
//   - receta_insumos.receta_id → receta_insumos.insumo_id (m:n con cantidad + merma_pct)
//   - rendimiento = porciones que produce la receta (ej: 1 = 1 plato; 4 = 4 porciones)
//
// CMV calculado en vivo via SQL function fn_calcular_costo_receta(receta_id).
// El margen % se computa contra items.precio_madre.
//
// Sub-recetas (PREPs): receta_insumos.prep_item_id apunta a otro item flageado
// es_prep_item=true. Ese item es producido in-house (ej: "Arroz cocido sushi")
// y a su vez tiene su propia receta. El cálculo de CMV resuelve recursivamente.
//
// Sin RPC para CRUD: recetas no está en C4 financiero. INSERT/UPDATE/DELETE
// directos sobre recetas + receta_insumos. Soft delete con deleted_at.

import { useState, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { db } from "../lib/supabase";
import { tienePermiso } from "../lib/auth";
import { useGuardedHandler } from "../lib/useGuardedHandler";
import { fmt_$ } from "@pase/shared/utils";
import type { Usuario, Local } from "../types/auth";
import { Modal } from "../components/ui";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";

interface Item {
  id: number;
  nombre: string;
  emoji: string | null;
  precio_madre: number | null;
  costo_actual: number | null;
  estado: string;
  es_combo: boolean;
  es_prep_item: boolean;
  receta_id_vigente: number | null;
  grupo_id: number | null;
}

interface ItemGrupo {
  id: number;
  nombre: string;
}

interface Receta {
  id: number;
  item_id: number;
  nombre: string;
  rendimiento: number;
  notas: string | null;
  activa: boolean;
}

interface RecetaInsumo {
  id: number;
  receta_id: number;
  insumo_id: number | null;
  prep_item_id: number | null;
  cantidad: number;
  merma_pct: number;
  notas: string | null;
  orden: number;
  // populated:
  insumo_nombre?: string;
  insumo_unidad?: string;
  insumo_costo?: number | null;
  prep_nombre?: string;
}

interface Insumo {
  id: number;
  nombre: string;
  unidad: string;
  costo_actual: number | null;
}

interface RecetasProps {
  user: Usuario;
  locales?: Local[];
  localActivo: number | null;
  /** Cuando true, omite el ph-row del header (lo dispara el módulo madre
   * Recetario). "Nueva receta" via URL query ?action=nueva-receta. */
  embedded?: boolean;
}

export default function Recetas({ user, embedded = false }: RecetasProps) {
  const { toast, showError, showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<Item[]>([]);
  const [grupos, setGrupos] = useState<ItemGrupo[]>([]);
  const [recetas, setRecetas] = useState<Receta[]>([]);
  const [insumos, setInsumos] = useState<Insumo[]>([]);
  const [search, setSearch] = useState("");
  const [filtro, setFiltro] = useState<"todos" | "con_receta" | "sin_receta">("todos");
  const [filtroGrupo, setFiltroGrupo] = useState<string>("__all");
  const [loading, setLoading] = useState(true);

  // Drawer de edición/creación de receta
  const [drawer, setDrawer] = useState<Item | null>(null);
  const [drawerReceta, setDrawerReceta] = useState<Receta | null>(null);
  const [drawerInsumos, setDrawerInsumos] = useState<RecetaInsumo[]>([]);
  const [drawerRendimiento, setDrawerRendimiento] = useState<string>("1");
  const [drawerNotas, setDrawerNotas] = useState<string>("");

  // Selector "Nueva receta" — modal con lista de items sin receta.
  const [selectorOpen, setSelectorOpen] = useState(false);

  const puedeEditar = tienePermiso(user, "rentabilidad") || user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin";

  const load = async () => {
    setLoading(true);
    // Cargar items, recetas activas, insumos y grupos en paralelo.
    // Items: solo disponibles, no open-item. Grupos: categorías (Rolls, Bebidas, etc.)
    const [itemsRes, recetasRes, insumosRes, gruposRes] = await Promise.all([
      db.from("items")
        .select("id, nombre, emoji, precio_madre, costo_actual, estado, es_combo, es_prep_item, receta_id_vigente, grupo_id")
        .eq("estado", "disponible")
        .eq("es_open_item", false)
        .is("deleted_at", null)
        .order("nombre"),
      db.from("recetas")
        .select("id, item_id, nombre, rendimiento, notas, activa")
        .eq("activa", true)
        .is("deleted_at", null),
      db.from("insumos")
        .select("id, nombre, unidad, costo_actual")
        .eq("activo", true)
        .is("deleted_at", null)
        .order("nombre"),
      db.from("item_grupos").select("id, nombre").order("nombre"),
    ]);

    if (itemsRes.error) { showError("No se pudieron cargar items: " + itemsRes.error.message); setLoading(false); return; }
    if (recetasRes.error) { showError("No se pudieron cargar recetas: " + recetasRes.error.message); setLoading(false); return; }
    if (insumosRes.error) { showError("No se pudieron cargar insumos: " + insumosRes.error.message); setLoading(false); return; }
    if (gruposRes.error) { console.warn("[Recetas] No se pudieron cargar item_grupos:", gruposRes.error.message); }

    setItems((itemsRes.data || []) as Item[]);
    setRecetas((recetasRes.data || []) as Receta[]);
    setInsumos((insumosRes.data || []) as Insumo[]);
    setGrupos((gruposRes.data || []) as ItemGrupo[]);
    setLoading(false);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Map item_id → receta activa (para mostrar info en lista).
  const recetaByItemId = useMemo(() => {
    const m = new Map<number, Receta>();
    for (const r of recetas) m.set(r.item_id, r);
    return m;
  }, [recetas]);

  // Map grupo_id → nombre del grupo (para mostrar categoría)
  const grupoById = useMemo(() => {
    const m = new Map<number, string>();
    for (const g of grupos) m.set(g.id, g.nombre);
    return m;
  }, [grupos]);

  // Grupos que están EN USO (tienen al menos 1 item activo) — para dropdown limpio
  const gruposEnUso = useMemo(() => {
    const set = new Set<number>();
    for (const it of items) if (it.grupo_id) set.add(it.grupo_id);
    return grupos.filter(g => set.has(g.id));
  }, [grupos, items]);

  // Filtrar items.
  const visible = items.filter(it => {
    if (search && !it.nombre.toLowerCase().includes(search.toLowerCase())) return false;
    const tiene = recetaByItemId.has(it.id);
    if (filtro === "con_receta" && !tiene) return false;
    if (filtro === "sin_receta" && tiene) return false;
    if (filtroGrupo !== "__all") {
      if (filtroGrupo === "__sin") {
        if (it.grupo_id) return false;
      } else if (String(it.grupo_id ?? "") !== filtroGrupo) {
        return false;
      }
    }
    return true;
  });

  // KPIs
  const totalItems = items.length;
  const conReceta = items.filter(i => recetaByItemId.has(i.id)).length;
  const sinReceta = totalItems - conReceta;
  const cobertura = totalItems > 0 ? Math.round((conReceta / totalItems) * 100) : 0;

  // Cargar receta + insumos al abrir drawer
  const abrirDrawer = async (item: Item) => {
    setDrawer(item);
    const receta = recetaByItemId.get(item.id);

    if (receta) {
      setDrawerReceta(receta);
      setDrawerRendimiento(String(receta.rendimiento));
      setDrawerNotas(receta.notas ?? "");
      // Cargar líneas de insumos.
      const { data: lineas, error } = await db
        .from("receta_insumos")
        .select("id, receta_id, insumo_id, prep_item_id, cantidad, merma_pct, notas, orden, insumos(nombre, unidad, costo_actual)")
        .eq("receta_id", receta.id)
        .is("deleted_at", null)
        .order("orden");
      if (error) { showError("No se pudieron cargar ingredientes: " + error.message); return; }
      type LineaRaw = RecetaInsumo & { insumos?: { nombre: string; unidad: string; costo_actual: number | null }[] | { nombre: string; unidad: string; costo_actual: number | null } | null };
      const populated: RecetaInsumo[] = ((lineas || []) as unknown as LineaRaw[]).map(l => {
        const ins = Array.isArray(l.insumos) ? l.insumos[0] : l.insumos;
        return {
          ...l,
          insumo_nombre: ins?.nombre,
          insumo_unidad: ins?.unidad,
          insumo_costo: ins?.costo_actual,
        };
      });
      setDrawerInsumos(populated);
    } else {
      // Item sin receta → preparar creación.
      setDrawerReceta(null);
      setDrawerRendimiento("1");
      setDrawerNotas("");
      setDrawerInsumos([]);
    }
  };

  const cerrarDrawer = () => {
    setDrawer(null);
    setDrawerReceta(null);
    setDrawerInsumos([]);
    setDrawerRendimiento("1");
    setDrawerNotas("");
  };

  // === Cálculos CMV en vivo (local, sin RPC) ===
  // Suma: cantidad × costo_unitario × (1 + merma_pct/100)
  // Por ahora ignoramos sub-recetas (prep_item_id) — para v1, solo costo directo.
  const cmvDrawer = useMemo(() => {
    return drawerInsumos.reduce((sum, l) => {
      const cantidad = Number(l.cantidad ?? 0);
      const costo = Number(l.insumo_costo ?? 0);
      const merma = Number(l.merma_pct ?? 0) / 100;
      return sum + (cantidad * costo * (1 + merma));
    }, 0);
  }, [drawerInsumos]);

  const cmvPorPorcion = useMemo(() => {
    const r = parseFloat(drawerRendimiento) || 1;
    return cmvDrawer / r;
  }, [cmvDrawer, drawerRendimiento]);

  const margenPct = useMemo(() => {
    if (!drawer?.precio_madre || Number(drawer.precio_madre) === 0) return null;
    const precio = Number(drawer.precio_madre);
    return ((precio - cmvPorPorcion) / precio) * 100;
  }, [drawer, cmvPorPorcion]);

  // === Mutaciones de líneas (local — se guarda al click "Guardar receta") ===
  const agregarLinea = () => {
    setDrawerInsumos([...drawerInsumos, {
      id: 0, // 0 = pendiente de crear
      receta_id: drawerReceta?.id ?? 0,
      insumo_id: insumos[0]?.id ?? null,
      prep_item_id: null,
      cantidad: 0,
      merma_pct: 0,
      notas: null,
      orden: drawerInsumos.length,
      insumo_nombre: insumos[0]?.nombre,
      insumo_unidad: insumos[0]?.unidad,
      insumo_costo: insumos[0]?.costo_actual ?? null,
    }]);
  };

  const eliminarLinea = (idx: number) => {
    setDrawerInsumos(drawerInsumos.filter((_, i) => i !== idx));
  };

  const updateLinea = (idx: number, patch: Partial<RecetaInsumo>) => {
    const next = [...drawerInsumos];
    const merged = { ...next[idx], ...patch } as RecetaInsumo;
    // Si cambió el insumo_id, repopular nombre/unidad/costo.
    if (patch.insumo_id !== undefined) {
      const ins = insumos.find(i => i.id === patch.insumo_id);
      merged.insumo_nombre = ins?.nombre;
      merged.insumo_unidad = ins?.unidad;
      merged.insumo_costo = ins?.costo_actual ?? null;
    }
    next[idx] = merged;
    setDrawerInsumos(next);
  };

  // === Guardar receta (crea o actualiza) ===
  const { run: guardar, isPending: guardando } = useGuardedHandler(async () => {
    if (!drawer) return;
    if (drawerInsumos.length === 0) { showError("Agregá al menos un ingrediente antes de guardar"); return; }
    const rendValue = parseFloat(drawerRendimiento);
    if (isNaN(rendValue) || rendValue <= 0) { showError("Rendimiento inválido"); return; }
    for (const l of drawerInsumos) {
      if (!l.insumo_id && !l.prep_item_id) { showError("Hay un ingrediente sin insumo asignado"); return; }
      if (Number(l.cantidad) <= 0) { showError(`Cantidad inválida en ${l.insumo_nombre ?? "ingrediente"}`); return; }
    }

    let recetaId = drawerReceta?.id;

    if (!recetaId) {
      // CREAR receta
      const { data: nuevaReceta, error: rErr } = await db.from("recetas").insert([{
        tenant_id: user.tenant_id,
        created_by: user.id,
        item_id: drawer.id,
        nombre: drawer.nombre,
        rendimiento: rendValue,
        notas: drawerNotas.trim() || null,
        activa: true,
      }]).select("id").single();
      if (rErr || !nuevaReceta) { showError("No se pudo crear receta: " + (rErr?.message ?? "vacío")); return; }
      recetaId = nuevaReceta.id;
    } else {
      // UPDATE header receta
      const { error: uErr } = await db.from("recetas").update({
        rendimiento: rendValue,
        notas: drawerNotas.trim() || null,
        updated_by: user.id,
      }).eq("id", recetaId);
      if (uErr) { showError("No se pudo actualizar receta: " + uErr.message); return; }
    }

    // Sincronizar líneas: simplísimo (delete all + insert all) — receta_insumos es chico.
    const { error: delErr } = await db.from("receta_insumos")
      .delete()
      .eq("receta_id", recetaId);
    if (delErr) { showError("No se pudieron limpiar ingredientes viejos: " + delErr.message); return; }

    const inserts = drawerInsumos.map((l, idx) => ({
      tenant_id: user.tenant_id,
      created_by: user.id,
      receta_id: recetaId,
      insumo_id: l.insumo_id,
      prep_item_id: l.prep_item_id,
      cantidad: Number(l.cantidad),
      merma_pct: Number(l.merma_pct),
      notas: l.notas,
      orden: idx,
    }));
    const { error: insErr } = await db.from("receta_insumos").insert(inserts);
    if (insErr) { showError("No se pudieron guardar ingredientes: " + insErr.message); return; }

    // Update items.receta_id_vigente para que apunte a esta receta (el POS lo lee).
    const { error: itErr } = await db.from("items")
      .update({ receta_id_vigente: recetaId })
      .eq("id", drawer.id);
    if (itErr) {
      // No bloqueante — log pero seguir.
      console.warn("[Recetas] No se pudo actualizar receta_id_vigente en items:", itErr.message);
    }

    showToast(drawerReceta ? "Receta actualizada" : "Receta creada");
    cerrarDrawer();
    await load();
  });

  // === Borrar receta ===
  const { run: borrar, isPending: borrando } = useGuardedHandler(async () => {
    if (!drawerReceta || !drawer) return;
    if (!confirm(`¿Borrar receta de "${drawer.nombre}"? Se podrá recrear después.`)) return;
    const { error } = await db.from("recetas")
      .update({ deleted_at: new Date().toISOString(), activa: false, updated_by: user.id })
      .eq("id", drawerReceta.id);
    if (error) { showError("No se pudo borrar: " + error.message); return; }
    await db.from("items").update({ receta_id_vigente: null }).eq("id", drawer.id);
    showToast("Receta borrada");
    cerrarDrawer();
    await load();
  });

  // Trigger "Nueva receta" desde el padre Recetario via ?action=nueva-receta.
  useEffect(() => {
    if (!embedded) return;
    if (searchParams.get("action") === "nueva-receta") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectorOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete("action");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, embedded]);

  // Items sin receta — alimentan el selector "Nueva receta".
  const itemsSinReceta = items.filter(it => !recetaByItemId.has(it.id));

  return (
    <div>
      <ToastComponent toast={toast} />
      {!embedded && (
        <div className="ph-row">
          <div>
            <div className="ph-title">Recetas</div>
            <div style={{ color: "var(--muted2)", fontSize: 12, marginTop: 2 }}>
              {totalItems} items totales · {conReceta} con receta · {sinReceta} sin receta · {cobertura}% cobertura
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {puedeEditar && (
              <button
                className="btn btn-acc"
                onClick={() => setSelectorOpen(true)}
                disabled={itemsSinReceta.length === 0}
                title={itemsSinReceta.length === 0 ? "Todos los items ya tienen receta" : ""}
              >
                + Nueva receta
              </button>
            )}
          </div>
        </div>
      )}

      {/* KPIs en banner si hay items sin receta */}
      {sinReceta > 0 && (
        <div style={{
          marginBottom: 12,
          padding: "10px 14px",
          background: "rgba(212,175,55,0.08)",
          border: "1px solid rgba(212,175,55,0.3)",
          borderRadius: 6,
          fontSize: 12,
          color: "var(--muted2)",
        }}>
          <strong style={{ color: "var(--gold)" }}>{sinReceta} item{sinReceta !== 1 ? "s" : ""} sin receta cargada.</strong> Sin recetas no podemos calcular CMV teórico ni descontar stock automáticamente al vender. Filtrá por "Sin receta" abajo para verlos.
        </div>
      )}

      {/* Filtros */}
      <div className="panel" style={{ marginBottom: 8 }}>
        <div style={{ padding: "10px 14px", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <input
            type="text"
            placeholder="Buscar item por nombre…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="search"
            style={{ flex: 1, minWidth: 200 }}
          />
          <select value={filtro} onChange={e => setFiltro(e.target.value as typeof filtro)} className="search" style={{ width: 180 }}>
            <option value="todos">Todos los items</option>
            <option value="con_receta">Con receta</option>
            <option value="sin_receta">Sin receta</option>
          </select>
          <select value={filtroGrupo} onChange={e => setFiltroGrupo(e.target.value)} className="search" style={{ width: 200 }}>
            <option value="__all">Todas las categorías</option>
            {gruposEnUso.map(g => <option key={g.id} value={String(g.id)}>{g.nombre}</option>)}
            <option value="__sin">Sin categoría</option>
          </select>
        </div>
      </div>

      {/* Tabla de items */}
      <div className="panel">
        {loading ? (
          <div className="loading" style={{ padding: 40 }}>Cargando recetas…</div>
        ) : visible.length === 0 ? (
          <div className="empty" style={{ padding: 40 }}>
            {items.length === 0 ? "No hay items disponibles. Cargá productos primero (módulo Catálogo en COMANDA)." : "Ningún item coincide con los filtros."}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Item</th>
                <th>Categoría</th>
                <th style={{ textAlign: "right" }}>Precio venta</th>
                <th>Receta</th>
                <th style={{ textAlign: "center" }}>Estado</th>
                <th style={{ width: 100 }}></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(it => {
                const r = recetaByItemId.get(it.id);
                const categoria = it.grupo_id ? grupoById.get(it.grupo_id) : null;
                return (
                  <tr key={it.id}>
                    <td style={{ width: 30, fontSize: 18 }}>{it.emoji ?? "—"}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{it.nombre}</div>
                      {it.es_combo && <span className="badge b-muted" style={{ fontSize: 9, marginRight: 4 }}>combo</span>}
                      {it.es_prep_item && <span className="badge b-info" style={{ fontSize: 9 }}>prep</span>}
                    </td>
                    <td>
                      {categoria ? (
                        <span className="badge b-muted" style={{ fontSize: 10 }}>{categoria}</span>
                      ) : (
                        <span className="badge b-warn" style={{ fontSize: 10 }}>Sin cat.</span>
                      )}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {it.precio_madre ? fmt_$(Number(it.precio_madre)) : <span style={{ color: "var(--muted2)" }}>—</span>}
                    </td>
                    <td>
                      {r ? (
                        <span style={{ fontSize: 11, color: "var(--muted2)" }}>{r.nombre} · rinde {r.rendimiento}</span>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--warn)" }}>Sin receta</span>
                      )}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      {r ? <span className="badge b-success" style={{ fontSize: 10 }}>OK</span> : <span className="badge b-warn" style={{ fontSize: 10 }}>Pendiente</span>}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => abrirDrawer(it)}>
                        {r ? "Editar" : "Crear"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Drawer/Modal de edición de receta */}
      <Modal
        isOpen={!!drawer}
        onClose={cerrarDrawer}
        title={drawer ? `${drawerReceta ? "Editar" : "Crear"} receta — ${drawer.nombre}` : ""}
        maxWidth={760}
        preventCloseOnOverlay
        footer={
          <>
            {drawerReceta && puedeEditar && (
              <button className="btn btn-danger-ghost" onClick={() => borrar()} disabled={guardando || borrando} style={{ marginRight: "auto" }}>
                Borrar receta
              </button>
            )}
            <button className="btn btn-sec" onClick={cerrarDrawer} disabled={guardando}>Cancelar</button>
            {puedeEditar && (
              <button className="btn btn-acc" onClick={() => guardar()} disabled={guardando || drawerInsumos.length === 0}>
                {guardando ? "Guardando…" : drawerReceta ? "Guardar cambios" : "Crear receta"}
              </button>
            )}
          </>
        }
      >
        {drawer && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Resumen CMV / Margen */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr 1fr",
              gap: 8,
              padding: 12,
              background: "var(--s2)",
              borderRadius: 6,
            }}>
              <KpiBlock label="Precio venta" value={drawer.precio_madre ? fmt_$(Number(drawer.precio_madre)) : "—"} />
              <KpiBlock label="CMV total" value={fmt_$(cmvDrawer)} />
              <KpiBlock label="CMV por porción" value={fmt_$(cmvPorPorcion)} highlight />
              <KpiBlock
                label="Margen %"
                value={margenPct != null ? `${margenPct.toFixed(1)}%` : "—"}
                tone={margenPct != null ? (margenPct > 60 ? "success" : margenPct > 30 ? "neutral" : "danger") : "muted"}
              />
            </div>

            {/* Rendimiento + notas */}
            <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 8 }}>
              <div>
                <label style={{ fontSize: 11, color: "var(--muted2)" }}>Rendimiento (porciones)</label>
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  value={drawerRendimiento}
                  onChange={e => setDrawerRendimiento(e.target.value)}
                  className="search"
                  style={{ width: "100%" }}
                />
                <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 4 }}>
                  Cuántas porciones produce esta receta
                </div>
              </div>
              <div>
                <label style={{ fontSize: 11, color: "var(--muted2)" }}>Notas (opcional)</label>
                <input
                  type="text"
                  value={drawerNotas}
                  onChange={e => setDrawerNotas(e.target.value)}
                  placeholder="Tiempo de preparación, alergenos, etc."
                  className="search"
                  style={{ width: "100%" }}
                />
              </div>
            </div>

            {/* Lista de ingredientes */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 500 }}>Ingredientes ({drawerInsumos.length})</div>
                {puedeEditar && (
                  <button className="btn btn-ghost btn-sm" onClick={agregarLinea} disabled={insumos.length === 0}>
                    + Agregar ingrediente
                  </button>
                )}
              </div>
              {insumos.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--warn)", fontSize: 12, background: "var(--s2)", borderRadius: 4 }}>
                  No hay insumos cargados. Andá a Insumos y agregá los ingredientes primero.
                </div>
              ) : drawerInsumos.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--muted2)", fontSize: 12, background: "var(--s2)", borderRadius: 4 }}>
                  Click "+ Agregar ingrediente" para empezar.
                </div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Insumo</th>
                      <th style={{ width: 100, textAlign: "right" }}>Cantidad</th>
                      <th style={{ width: 60 }}>Unidad</th>
                      <th style={{ width: 90, textAlign: "right" }}>Merma %</th>
                      <th style={{ width: 110, textAlign: "right" }}>Costo línea</th>
                      <th style={{ width: 50 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {drawerInsumos.map((l, idx) => {
                      const costoLinea = Number(l.cantidad ?? 0) * Number(l.insumo_costo ?? 0) * (1 + Number(l.merma_pct ?? 0) / 100);
                      return (
                        <tr key={`${l.id}-${idx}`}>
                          <td>
                            <select
                              value={l.insumo_id ?? ""}
                              onChange={e => updateLinea(idx, { insumo_id: e.target.value ? parseInt(e.target.value) : null })}
                              className="search"
                              style={{ width: "100%" }}
                              disabled={!puedeEditar}
                            >
                              {insumos.map(i => <option key={i.id} value={i.id}>{i.nombre} ({fmt_$(Number(i.costo_actual ?? 0))}/{i.unidad})</option>)}
                            </select>
                          </td>
                          <td>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={l.cantidad}
                              onChange={e => updateLinea(idx, { cantidad: parseFloat(e.target.value) || 0 })}
                              className="search mono"
                              style={{ width: "100%", textAlign: "right" }}
                              disabled={!puedeEditar}
                            />
                          </td>
                          <td className="mono" style={{ fontSize: 11, color: "var(--muted2)" }}>{l.insumo_unidad}</td>
                          <td>
                            <input
                              type="number"
                              step="1"
                              min="0"
                              max="50"
                              value={l.merma_pct}
                              onChange={e => updateLinea(idx, { merma_pct: parseFloat(e.target.value) || 0 })}
                              className="search mono"
                              style={{ width: "100%", textAlign: "right" }}
                              disabled={!puedeEditar}
                            />
                          </td>
                          <td className="mono" style={{ textAlign: "right" }}>
                            {fmt_$(costoLinea)}
                          </td>
                          <td style={{ textAlign: "center" }}>
                            {puedeEditar && (
                              <button onClick={() => eliminarLinea(idx)} className="btn btn-ghost btn-sm" title="Eliminar" style={{ padding: "2px 6px" }}>×</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Modal selector "Nueva receta" — elegir un item sin receta y abrir el editor */}
      <Modal
        isOpen={selectorOpen}
        onClose={() => setSelectorOpen(false)}
        title="Nueva receta"
        maxWidth={520}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 12, color: "var(--muted2)" }}>
            Elegí el item al que querés cargarle la receta. Solo se muestran los que aún no tienen una.
          </div>
          {itemsSinReceta.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}>
              Todos los items ya tienen receta cargada.
            </div>
          ) : (
            <div style={{ maxHeight: 400, overflowY: "auto", border: "1px solid var(--bd)", borderRadius: 6 }}>
              {itemsSinReceta.map(it => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => {
                    setSelectorOpen(false);
                    void abrirDrawer(it);
                  }}
                  style={{
                    display: "flex",
                    width: "100%",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    background: "transparent",
                    border: "none",
                    borderBottom: "1px solid var(--bd)",
                    cursor: "pointer",
                    textAlign: "left",
                    color: "var(--text)",
                    fontSize: 13,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--s2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ fontSize: 18, width: 26 }}>{it.emoji ?? "—"}</span>
                  <span style={{ flex: 1 }}>{it.nombre}</span>
                  <span className="mono" style={{ color: "var(--muted2)", fontSize: 11 }}>
                    {it.precio_madre ? `$${Number(it.precio_madre).toLocaleString("es-AR")}` : "—"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

function KpiBlock({ label, value, highlight, tone }: { label: string; value: string; highlight?: boolean; tone?: "success" | "danger" | "neutral" | "muted" }) {
  const color = tone === "success" ? "var(--success)"
              : tone === "danger" ? "var(--danger)"
              : tone === "muted" ? "var(--muted2)"
              : highlight ? "var(--gold)"
              : "var(--text)";
  return (
    <div>
      <div style={{ fontSize: 10, textTransform: "uppercase", color: "var(--muted2)", letterSpacing: 0.5 }}>{label}</div>
      <div className="mono" style={{ fontSize: 16, fontWeight: 600, color, marginTop: 2 }}>{value}</div>
    </div>
  );
}
