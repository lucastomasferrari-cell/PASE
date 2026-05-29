// ─── INSUMOS ──────────────────────────────────────────────────────────────
// Catálogo de insumos (materia prima) del tenant. Usado por:
//   - Recetas: definir qué ingredientes lleva cada plato → CMV teórico
//   - Stock (módulo Rentabilidad): valorización y alertas de quiebre
//   - Mermas (COMANDA): descuento de stock con motivo
//   - Conteos (COMANDA): reconciliación stock teórico vs real
//
// Modelo:
//   - insumos.local_id puede ser NULL (insumo global del tenant) o specific local
//   - Hoy en Neko los 15 insumos están asignados a local_id=7 (legacy sprint 1-4)
//   - Esta UI permite cambiar local_id (incluyendo "global del tenant" = NULL)
//
// Categoría P&L: clasificación contable (Carnes, Pescados, Vegetales, etc.)
// usada por el dashboard de Stock para agrupar el valor del inventario.
//
// Sin RPC: insumos NO está en C4 (tablas financieras protegidas), permite
// INSERT/UPDATE/DELETE directo. Soft delete con `deleted_at` (audit trail).

import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { db } from "../lib/supabase";
import { tienePermiso } from "../lib/auth";
import { useGuardedHandler } from "../lib/useGuardedHandler";
import { fmt_$ } from "@pase/shared/utils";
import type { Usuario, Local } from "../types/auth";
import { Modal } from "../components/ui";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";

// Categorías P&L sugeridas (datalist — el usuario puede escribir cualquier otra).
// Estas son las habituales en gastronomía argentina.
const CATEGORIAS_PL_SUGERIDAS = [
  "Carnes",
  "Pescados y mariscos",
  "Vegetales y verduras",
  "Frutas",
  "Lácteos",
  "Granos y harinas",
  "Bebidas",
  "Aceites y grasas",
  "Condimentos y especias",
  "Panificados",
  "Embutidos",
  "Conservas",
  "Limpieza",
  "Descartables",
  "Otros",
];

// Unidades estándar (las que ya existen en DB + las habituales).
const UNIDADES = ["kg", "g", "L", "ml", "un", "docena"];

interface Insumo {
  id: number;
  nombre: string;
  descripcion: string | null;
  emoji: string | null;
  unidad: string;
  costo_actual: number | null;
  costo_actualizado_at: string | null;
  costo_promedio_30d: number | null;
  categoria_pl: string | null;
  stock_actual: number | null;
  stock_minimo: number | null;
  stock_maximo: number | null;
  ubicacion: string | null;
  activo: boolean;
  es_comprado: boolean;
  stock_disponible: boolean;
  local_id: number | null;
  tenant_id: string;
  proveedor_preferido_id: number | null;
}

interface FormInsumo {
  nombre: string;
  descripcion: string;
  emoji: string;
  unidad: string;
  costo_actual: string;
  categoria_pl: string;
  stock_minimo: string;
  stock_maximo: string;
  ubicacion: string;
  activo: boolean;
  es_comprado: boolean;
  stock_disponible: boolean;
  local_id: string;
}

const emptyForm: FormInsumo = {
  nombre: "",
  descripcion: "",
  emoji: "",
  unidad: "kg",
  costo_actual: "",
  categoria_pl: "",
  stock_minimo: "",
  stock_maximo: "",
  ubicacion: "",
  activo: true,
  es_comprado: true,
  stock_disponible: true,
  local_id: "", // "" = global del tenant (NULL)
};

interface InsumosProps {
  user: Usuario;
  locales?: Local[];
  localActivo: number | null;
  /** Cuando true, omite el ph-row con título + botones (lo dispara el módulo
   * madre Recetario). Triggering "nuevo insumo" via URL query ?action=nuevo. */
  embedded?: boolean;
}

export default function Insumos({ user, locales = [], embedded = false }: InsumosProps) {
  const { toast, showError, showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [insumos, setInsumos] = useState<Insumo[]>([]);
  const [search, setSearch] = useState("");
  const [filtroCategoria, setFiltroCategoria] = useState<string>("__all");
  const [verInactivos, setVerInactivos] = useState(false);
  const [loading, setLoading] = useState(true);

  const [modalNew, setModalNew] = useState(false);
  const [modalEdit, setModalEdit] = useState<Insumo | null>(null);
  const [form, setForm] = useState<FormInsumo>(emptyForm);

  // En modo embedded, el padre Recetario dispara "Nuevo insumo" via query
  // param ?action=nuevo (mismo patrón que Proveedores embebido en Compras).
  useEffect(() => {
    if (!embedded) return;
    if (searchParams.get("action") === "nuevo-insumo") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModalNew(true);
      const next = new URLSearchParams(searchParams);
      next.delete("action");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, embedded]);

  // Slug "rentabilidad" cubre todo el módulo Stock+Insumos+Recetas en el sistema
  // de permisos (auth.ts MODULOS). Si en el futuro queremos granularidad fina,
  // agregar slugs "insumos" y "recetas" al array MODULOS.
  const puedeEditar = tienePermiso(user, "rentabilidad") || user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin";

  const load = async () => {
    setLoading(true);
    // Sin applyLocalScope: insumos es catálogo (potencialmente global por tenant).
    // RLS server-side ya filtra por tenant_id del usuario.
    const { data, error } = await db
      .from("insumos")
      .select("id, nombre, descripcion, emoji, unidad, costo_actual, costo_actualizado_at, costo_promedio_30d, categoria_pl, stock_actual, stock_minimo, stock_maximo, ubicacion, activo, es_comprado, stock_disponible, local_id, tenant_id, proveedor_preferido_id")
      .is("deleted_at", null)
      .order("nombre");
    if (error) { showError("No se pudo cargar insumos: " + error.message); setLoading(false); return; }
    setInsumos((data || []) as Insumo[]);
    setLoading(false);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Categorías que aparecen en la data (para el filtro dropdown).
  const categoriasEnUso = Array.from(new Set(insumos.map(i => i.categoria_pl).filter(Boolean) as string[])).sort();

  // Filtrado en cliente (insumos es chico: < 500 normalmente).
  const visible = insumos.filter(i => {
    if (!verInactivos && !i.activo) return false;
    if (search && !i.nombre.toLowerCase().includes(search.toLowerCase())) return false;
    if (filtroCategoria !== "__all" && i.categoria_pl !== filtroCategoria) return false;
    return true;
  });

  // KPIs
  const total = insumos.filter(i => i.activo).length;
  const sinCosto = insumos.filter(i => i.activo && (!i.costo_actual || Number(i.costo_actual) === 0)).length;
  const sinCategoria = insumos.filter(i => i.activo && !i.categoria_pl).length;
  const enQuiebre = insumos.filter(i => i.activo && i.stock_minimo != null && i.stock_actual != null && Number(i.stock_actual) < Number(i.stock_minimo)).length;

  // CRUD handlers
  const abrirNuevo = () => {
    setForm(emptyForm);
    setModalNew(true);
  };

  const abrirEditar = (ins: Insumo) => {
    setForm({
      nombre: ins.nombre,
      descripcion: ins.descripcion ?? "",
      emoji: ins.emoji ?? "",
      unidad: ins.unidad,
      costo_actual: ins.costo_actual != null ? String(ins.costo_actual) : "",
      categoria_pl: ins.categoria_pl ?? "",
      stock_minimo: ins.stock_minimo != null ? String(ins.stock_minimo) : "",
      stock_maximo: ins.stock_maximo != null ? String(ins.stock_maximo) : "",
      ubicacion: ins.ubicacion ?? "",
      activo: ins.activo,
      es_comprado: ins.es_comprado,
      stock_disponible: ins.stock_disponible,
      local_id: ins.local_id != null ? String(ins.local_id) : "",
    });
    setModalEdit(ins);
  };

  // Validación común antes de guardar.
  const validarForm = (): string | null => {
    if (!form.nombre.trim()) return "El nombre es obligatorio";
    if (!form.unidad) return "La unidad es obligatoria";
    const costo = parseFloat(form.costo_actual);
    if (form.costo_actual && (isNaN(costo) || costo < 0)) return "Costo inválido";
    const min = parseFloat(form.stock_minimo);
    if (form.stock_minimo && (isNaN(min) || min < 0)) return "Stock mínimo inválido";
    const max = parseFloat(form.stock_maximo);
    if (form.stock_maximo && (isNaN(max) || max < 0)) return "Stock máximo inválido";
    if (form.stock_minimo && form.stock_maximo && min > max) return "Stock mínimo no puede ser mayor que el máximo";
    return null;
  };

  const buildPayload = () => {
    const costo = form.costo_actual ? parseFloat(form.costo_actual) : null;
    return {
      nombre: form.nombre.trim(),
      descripcion: form.descripcion.trim() || null,
      emoji: form.emoji.trim() || null,
      unidad: form.unidad,
      costo_actual: costo,
      // costo_actualizado_at solo si el user cargó costo nuevo (server lo decide en edit)
      categoria_pl: form.categoria_pl.trim() || null,
      stock_minimo: form.stock_minimo ? parseFloat(form.stock_minimo) : null,
      stock_maximo: form.stock_maximo ? parseFloat(form.stock_maximo) : null,
      ubicacion: form.ubicacion.trim() || null,
      activo: form.activo,
      es_comprado: form.es_comprado,
      stock_disponible: form.stock_disponible,
      local_id: form.local_id ? parseInt(form.local_id) : null,
    };
  };

  const { run: crear, isPending: creando } = useGuardedHandler(async () => {
    const err = validarForm();
    if (err) { showError(err); return; }
    const payload = {
      ...buildPayload(),
      tenant_id: user.tenant_id,
      created_by: user.id,
      ...(form.costo_actual ? { costo_actualizado_at: new Date().toISOString() } : {}),
    };
    const { error } = await db.from("insumos").insert([payload]);
    if (error) { showError("No se pudo crear: " + error.message); return; }
    showToast("Insumo creado");
    setModalNew(false);
    setForm(emptyForm);
    await load();
  });

  const { run: actualizar, isPending: actualizando } = useGuardedHandler(async () => {
    if (!modalEdit) return;
    const err = validarForm();
    if (err) { showError(err); return; }
    const costoNuevo = form.costo_actual ? parseFloat(form.costo_actual) : null;
    const costoCambio = costoNuevo != null && costoNuevo !== Number(modalEdit.costo_actual ?? 0);
    const payload = {
      ...buildPayload(),
      updated_by: user.id,
      ...(costoCambio ? { costo_actualizado_at: new Date().toISOString() } : {}),
    };
    const { error } = await db.from("insumos").update(payload).eq("id", modalEdit.id);
    if (error) { showError("No se pudo guardar: " + error.message); return; }
    // Si cambió el costo, registrar en history para que las alertas y CMV se mantengan al día.
    if (costoCambio) {
      const variacionPct = modalEdit.costo_actual && Number(modalEdit.costo_actual) > 0
        ? ((costoNuevo! - Number(modalEdit.costo_actual)) / Number(modalEdit.costo_actual)) * 100
        : null;
      await db.from("insumos_costo_history").insert([{
        tenant_id: user.tenant_id,
        insumo_id: modalEdit.id,
        costo_anterior: modalEdit.costo_actual,
        costo_nuevo: costoNuevo,
        variacion_pct: variacionPct,
        fuente: "manual_pase",
        changed_by: user.id,
      }]);
    }
    showToast("Insumo actualizado");
    setModalEdit(null);
    await load();
  });

  const { run: archivar, isPending: archivando } = useGuardedHandler(async () => {
    if (!modalEdit) return;
    if (!confirm(`¿Archivar insumo "${modalEdit.nombre}"? No se borra, solo deja de aparecer en listados.`)) return;
    const { error } = await db.from("insumos").update({
      deleted_at: new Date().toISOString(),
      updated_by: user.id,
    }).eq("id", modalEdit.id);
    if (error) { showError("No se pudo archivar: " + error.message); return; }
    showToast("Insumo archivado");
    setModalEdit(null);
    await load();
  });

  // Datalist global compartido entre create + edit modal.
  const catalogoCategorias = Array.from(new Set([...CATEGORIAS_PL_SUGERIDAS, ...categoriasEnUso])).sort();

  return (
    <div>
      <ToastComponent toast={toast} />
      {!embedded && (
        <div className="ph-row">
          <div>
            <div className="ph-title">Insumos</div>
            <div style={{ color: "var(--muted2)", fontSize: 12, marginTop: 2 }}>
              Catálogo de ingredientes · {total} activos
              {sinCosto > 0 && <> · <span style={{ color: "var(--warn)" }}>{sinCosto} sin costo</span></>}
              {sinCategoria > 0 && <> · <span style={{ color: "var(--warn)" }}>{sinCategoria} sin categoría</span></>}
              {enQuiebre > 0 && <> · <span style={{ color: "var(--danger)" }}>{enQuiebre} en quiebre</span></>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {puedeEditar && (
              <button className="btn btn-acc" onClick={abrirNuevo}>+ Nuevo insumo</button>
            )}
          </div>
        </div>
      )}

      {/* Filtros */}
      <div className="panel" style={{ marginBottom: 8 }}>
        <div style={{ padding: "10px 14px", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <input
            type="text"
            placeholder="Buscar por nombre…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="search"
            style={{ flex: 1, minWidth: 200 }}
          />
          <select value={filtroCategoria} onChange={e => setFiltroCategoria(e.target.value)} className="search" style={{ width: 200 }}>
            <option value="__all">Todas las categorías</option>
            {categoriasEnUso.map(c => <option key={c} value={c}>{c}</option>)}
            <option value="__sin">Sin categoría</option>
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={verInactivos} onChange={e => setVerInactivos(e.target.checked)} />
            Ver inactivos
          </label>
        </div>
      </div>

      {/* Tabla */}
      <div className="panel">
        {loading ? (
          <div className="loading" style={{ padding: 40 }}>Cargando insumos…</div>
        ) : visible.length === 0 ? (
          <div className="empty" style={{ padding: 40 }}>
            {insumos.length === 0 ? "No hay insumos cargados todavía. Click '+ Nuevo insumo' para crear el primero." : "Ningún insumo coincide con los filtros."}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Nombre</th>
                <th>Categoría</th>
                <th>Unidad</th>
                <th style={{ textAlign: "right" }}>Costo</th>
                <th style={{ textAlign: "right" }}>Stock</th>
                <th style={{ textAlign: "right" }}>Mínimo</th>
                <th>Estado</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(i => {
                const enQuiebre = i.stock_minimo != null && i.stock_actual != null && Number(i.stock_actual) < Number(i.stock_minimo);
                return (
                  <tr key={i.id} style={{ opacity: i.activo ? 1 : 0.45 }}>
                    <td style={{ width: 30, fontSize: 18 }}>{i.emoji ?? "—"}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{i.nombre}</div>
                      {i.descripcion && <div style={{ fontSize: 10, color: "var(--muted2)" }}>{i.descripcion}</div>}
                    </td>
                    <td>
                      {i.categoria_pl ? (
                        <span className="badge b-muted" style={{ fontSize: 10 }}>{i.categoria_pl}</span>
                      ) : (
                        <span className="badge b-warn" style={{ fontSize: 10 }}>Sin cat.</span>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>{i.unidad}</td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {i.costo_actual ? fmt_$(Number(i.costo_actual)) : <span style={{ color: "var(--warn)" }}>—</span>}
                    </td>
                    <td className="mono" style={{ textAlign: "right", color: enQuiebre ? "var(--danger)" : undefined }}>
                      {i.stock_actual != null ? Number(i.stock_actual).toFixed(2) : "—"}
                    </td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--muted2)" }}>
                      {i.stock_minimo != null ? Number(i.stock_minimo).toFixed(2) : "—"}
                    </td>
                    <td>
                      {!i.activo ? <span className="badge b-muted" style={{ fontSize: 10 }}>Inactivo</span>
                        : !i.stock_disponible ? <span className="badge b-warn" style={{ fontSize: 10 }}>86</span>
                        : enQuiebre ? <span className="badge b-danger" style={{ fontSize: 10 }}>Quiebre</span>
                        : <span className="badge b-success" style={{ fontSize: 10 }}>OK</span>}
                    </td>
                    <td>
                      {puedeEditar && (
                        <button className="btn btn-ghost btn-sm" onClick={() => abrirEditar(i)}>Editar</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Modal Nuevo */}
      <Modal
        isOpen={modalNew}
        onClose={() => setModalNew(false)}
        title="Nuevo insumo"
        maxWidth={560}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setModalNew(false)} disabled={creando}>Cancelar</button>
            <button className="btn btn-acc" onClick={() => crear()} disabled={creando}>
              {creando ? "Guardando…" : "Crear"}
            </button>
          </>
        }
      >
        <FormFields form={form} setForm={setForm} catalogoCategorias={catalogoCategorias} locales={locales} />
      </Modal>

      {/* Modal Edición */}
      <Modal
        isOpen={!!modalEdit}
        onClose={() => setModalEdit(null)}
        title={modalEdit ? `Editar: ${modalEdit.nombre}` : ""}
        maxWidth={560}
        footer={
          <>
            <button className="btn btn-danger-ghost" onClick={() => archivar()} disabled={archivando || actualizando} style={{ marginRight: "auto" }}>
              Archivar
            </button>
            <button className="btn btn-sec" onClick={() => setModalEdit(null)} disabled={actualizando}>Cancelar</button>
            <button className="btn btn-acc" onClick={() => actualizar()} disabled={actualizando}>
              {actualizando ? "Guardando…" : "Guardar"}
            </button>
          </>
        }
      >
        <FormFields form={form} setForm={setForm} catalogoCategorias={catalogoCategorias} locales={locales} />
        {modalEdit && modalEdit.costo_actualizado_at && (
          <div style={{ marginTop: 12, padding: 8, background: "var(--s2)", borderRadius: 4, fontSize: 11, color: "var(--muted2)" }}>
            Último cambio de costo: {new Date(modalEdit.costo_actualizado_at).toLocaleDateString("es-AR")}
            {modalEdit.costo_promedio_30d ? ` · Promedio 30d: ${fmt_$(Number(modalEdit.costo_promedio_30d))}` : ""}
          </div>
        )}
      </Modal>
    </div>
  );
}

// ─── FormFields (compartido entre Nuevo + Editar) ────────────────────────────
function FormFields({
  form, setForm, catalogoCategorias, locales,
}: {
  form: FormInsumo;
  setForm: (f: FormInsumo) => void;
  catalogoCategorias: string[];
  locales: Local[];
}) {
  const set = <K extends keyof FormInsumo>(k: K, v: FormInsumo[K]) => setForm({ ...form, [k]: v });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: 8 }}>
        <div>
          <label style={{ fontSize: 11, color: "var(--muted2)" }}>Emoji</label>
          <input
            type="text"
            value={form.emoji}
            onChange={e => set("emoji", e.target.value)}
            placeholder="🥩"
            className="search"
            style={{ width: "100%", fontSize: 18, textAlign: "center" }}
            maxLength={4}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, color: "var(--muted2)" }}>Nombre *</label>
          <input
            type="text"
            value={form.nombre}
            onChange={e => set("nombre", e.target.value)}
            placeholder="Salmón rosado"
            className="search"
            style={{ width: "100%" }}
            autoFocus
          />
        </div>
      </div>

      <div>
        <label style={{ fontSize: 11, color: "var(--muted2)" }}>Descripción (opcional)</label>
        <textarea
          value={form.descripcion}
          onChange={e => set("descripcion", e.target.value)}
          placeholder="Notas internas: marca preferida, cómo conservarlo, etc."
          className="search"
          style={{ width: "100%", minHeight: 50, resize: "vertical" }}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <label style={{ fontSize: 11, color: "var(--muted2)" }}>Unidad *</label>
          <select value={form.unidad} onChange={e => set("unidad", e.target.value)} className="search" style={{ width: "100%" }}>
            {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, color: "var(--muted2)" }}>Costo actual (por unidad)</label>
          <input
            type="number"
            step="0.01"
            value={form.costo_actual}
            onChange={e => set("costo_actual", e.target.value)}
            placeholder="0.00"
            className="search"
            style={{ width: "100%" }}
          />
        </div>
      </div>

      <div>
        <label style={{ fontSize: 11, color: "var(--muted2)" }}>Categoría P&amp;L</label>
        <input
          type="text"
          list="categoria-pl-list"
          value={form.categoria_pl}
          onChange={e => set("categoria_pl", e.target.value)}
          placeholder="Ej: Pescados y mariscos"
          className="search"
          style={{ width: "100%" }}
        />
        <datalist id="categoria-pl-list">
          {catalogoCategorias.map(c => <option key={c} value={c} />)}
        </datalist>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <div>
          <label style={{ fontSize: 11, color: "var(--muted2)" }}>Stock mínimo</label>
          <input
            type="number"
            step="0.01"
            value={form.stock_minimo}
            onChange={e => set("stock_minimo", e.target.value)}
            placeholder="0"
            className="search"
            style={{ width: "100%" }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, color: "var(--muted2)" }}>Stock máximo</label>
          <input
            type="number"
            step="0.01"
            value={form.stock_maximo}
            onChange={e => set("stock_maximo", e.target.value)}
            placeholder="0"
            className="search"
            style={{ width: "100%" }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, color: "var(--muted2)" }}>Ubicación</label>
          <input
            type="text"
            value={form.ubicacion}
            onChange={e => set("ubicacion", e.target.value)}
            placeholder="Heladera 2"
            className="search"
            style={{ width: "100%" }}
          />
        </div>
      </div>

      <div>
        <label style={{ fontSize: 11, color: "var(--muted2)" }}>Local</label>
        <select value={form.local_id} onChange={e => set("local_id", e.target.value)} className="search" style={{ width: "100%" }}>
          <option value="">Global (compartido entre locales)</option>
          {locales.map(l => <option key={l.id} value={String(l.id)}>{l.nombre}</option>)}
        </select>
        <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 4 }}>
          "Global" significa que el insumo está disponible en todos los locales del tenant. El stock siempre es por local.
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", padding: 8, background: "var(--s2)", borderRadius: 4 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={form.activo} onChange={e => set("activo", e.target.checked)} />
          Activo
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={form.es_comprado} onChange={e => set("es_comprado", e.target.checked)} />
          Comprado (vs. producido in-house)
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={form.stock_disponible} onChange={e => set("stock_disponible", e.target.checked)} />
          Disponible (no "86")
        </label>
      </div>
    </div>
  );
}
