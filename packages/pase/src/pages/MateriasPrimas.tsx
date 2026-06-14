// ─── MATERIAS PRIMAS ──────────────────────────────────────────────────────
// Catálogo de "qué te vende cada proveedor en qué unidad de compra".
//
// Modelo: tabla puente entre `proveedores` y `insumos`.
//   proveedor "Pescadería Norte"
//     vende → materia_prima "Bolsa salmón 5kg"
//             (unidad_compra="bolsa", factor_conversion=5)
//             apunta a → insumo "Salmón" (unidad=kg)
//
// Por qué importa: el trigger `trg_factura_item_entrada_stock` se activa
// cuando un factura_item tiene `materia_prima_id` seteado. Sin materias
// primas cargadas, las facturas NO suman stock automáticamente.
//
// Spec corto:
//   - INSERT/UPDATE directo (no es tabla financiera C4)
//   - Soft delete con deleted_at
//   - Trigger trg_factura_item_actualiza_mp actualiza precio_actual cuando
//     se carga una factura nueva con esta materia_prima.

import { useState, useEffect, useMemo } from "react";
import { db } from "../lib/supabase";
import { tienePermiso } from "../lib/auth";
import { useGuardedHandler } from "../lib/useGuardedHandler";
import { fmt_$ } from "@pase/shared/utils";
import type { Usuario, Local } from "../types/auth";
import { Modal } from "../components/ui";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";

// Unidades de compra habituales: cómo te vende el proveedor.
const UNIDADES_COMPRA = [
  "bolsa", "caja", "kg", "g", "L", "ml", "un", "docena", "paquete", "atado", "bandeja", "rollo",
];

interface MateriaPrima {
  id: number;
  nombre: string;
  proveedor_id: number | null;
  insumo_id: number;
  unidad_compra: string;
  factor_conversion: number;
  merma_pct: number;
  precio_actual: number | null;
  precio_actualizado_at: string | null;
  notas: string | null;
  activa: boolean;
}

interface Proveedor {
  id: number;
  nombre: string;
  estado: string;
}

interface Insumo {
  id: number;
  nombre: string;
  unidad: string;
}

interface Form {
  nombre: string;
  proveedor_id: string;
  insumo_id: string;
  unidad_compra: string;
  factor_conversion: string;
  precio_actual: string;
  notas: string;
  activa: boolean;
}

const emptyForm: Form = {
  nombre: "",
  proveedor_id: "",
  insumo_id: "",
  unidad_compra: "bolsa",
  factor_conversion: "1",
  precio_actual: "",
  notas: "",
  activa: true,
};

interface MateriasPrimasProps {
  user: Usuario;
  locales?: Local[];
  localActivo: number | null;
  /** Cuando true, omite el ph-row (lo dispara el módulo madre Recetario).
   * "Nueva materia prima" via URL query ?action=nueva-mp. */
  embedded?: boolean;
}

export default function MateriasPrimas({ user, embedded = false }: MateriasPrimasProps) {
  const { toast, showError, showToast } = useToast();
  const [mps, setMps] = useState<MateriaPrima[]>([]);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [insumos, setInsumos] = useState<Insumo[]>([]);
  const [search, setSearch] = useState("");
  const [filtroProv, setFiltroProv] = useState<string>("__all");
  const [verInactivas, setVerInactivas] = useState(false);
  const [loading, setLoading] = useState(true);

  const [modalNew, setModalNew] = useState(false);
  const [modalEdit, setModalEdit] = useState<MateriaPrima | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);

  // Quick-create insumo inline (automatización 29-may): cuando el user está
  // creando una MP y el insumo no existe, abre mini-modal para crearlo sin
  // salir del flow.
  const [quickInsumoOpen, setQuickInsumoOpen] = useState(false);
  const [quickInsumoForm, setQuickInsumoForm] = useState({ nombre: "", unidad: "kg" });

  const puedeEditar = tienePermiso(user, "rentabilidad") || user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin";

  const load = async () => {
    setLoading(true);
    const [mpRes, provRes, insRes] = await Promise.all([
      db.from("materias_primas")
        .select("id, nombre, proveedor_id, insumo_id, unidad_compra, factor_conversion, merma_pct, precio_actual, precio_actualizado_at, notas, activa")
        .is("deleted_at", null)
        .order("nombre"),
      db.from("proveedores")
        .select("id, nombre, estado")
        .eq("estado", "Activo")
        .order("nombre"),
      db.from("insumos")
        .select("id, nombre, unidad")
        .eq("activo", true)
        .is("deleted_at", null)
        .order("nombre"),
    ]);
    if (mpRes.error) { showError("No se pudieron cargar materias primas: " + mpRes.error.message); setLoading(false); return; }
    if (provRes.error) { showError("No se pudieron cargar proveedores: " + provRes.error.message); setLoading(false); return; }
    if (insRes.error) { showError("No se pudieron cargar insumos: " + insRes.error.message); setLoading(false); return; }
    setMps((mpRes.data || []) as MateriaPrima[]);
    setProveedores((provRes.data || []) as Proveedor[]);
    setInsumos((insRes.data || []) as Insumo[]);
    setLoading(false);
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Maps para joins en cliente
  const provById = useMemo(() => {
    const m = new Map<number, Proveedor>();
    for (const p of proveedores) m.set(p.id, p);
    return m;
  }, [proveedores]);

  const insById = useMemo(() => {
    const m = new Map<number, Insumo>();
    for (const i of insumos) m.set(i.id, i);
    return m;
  }, [insumos]);

  // Proveedores que SÍ tienen materias primas (para dropdown limpio)
  const provsConMP = useMemo(() => {
    const set = new Set<number>();
    for (const m of mps) if (m.proveedor_id) set.add(m.proveedor_id);
    return proveedores.filter(p => set.has(p.id));
  }, [mps, proveedores]);

  // Filtrado en cliente
  const visible = mps.filter(m => {
    if (!verInactivas && !m.activa) return false;
    if (search && !m.nombre.toLowerCase().includes(search.toLowerCase())) return false;
    if (filtroProv === "__sin") {
      if (m.proveedor_id) return false;
    } else if (filtroProv !== "__all") {
      if (String(m.proveedor_id ?? "") !== filtroProv) return false;
    }
    return true;
  });

  // KPIs
  const total = mps.filter(m => m.activa).length;
  const sinPrecio = mps.filter(m => m.activa && (!m.precio_actual || Number(m.precio_actual) === 0)).length;
  const sinProveedor = mps.filter(m => m.activa && !m.proveedor_id).length;

  // Sin insumos → no se puede crear materia prima
  const sinInsumos = insumos.length === 0;

  const abrirNuevo = () => {
    if (sinInsumos) { showError("Primero cargá insumos en Insumos antes de crear materias primas"); return; }
    setForm({ ...emptyForm, insumo_id: String(insumos[0]!.id) });
    setModalNew(true);
  };

  const abrirEditar = (mp: MateriaPrima) => {
    setForm({
      nombre: mp.nombre,
      proveedor_id: mp.proveedor_id != null ? String(mp.proveedor_id) : "",
      insumo_id: String(mp.insumo_id),
      unidad_compra: mp.unidad_compra,
      factor_conversion: String(mp.factor_conversion),
      precio_actual: mp.precio_actual != null ? String(mp.precio_actual) : "",
      notas: mp.notas ?? "",
      activa: mp.activa,
    });
    setModalEdit(mp);
  };

  const validar = (): string | null => {
    if (!form.nombre.trim()) return "El nombre es obligatorio";
    if (!form.insumo_id) return "Tenés que vincular un insumo";
    if (!form.unidad_compra) return "Especificá la unidad de compra";
    const factor = parseFloat(form.factor_conversion);
    if (isNaN(factor) || factor <= 0) return "El factor de conversión debe ser > 0";
    if (form.precio_actual) {
      const p = parseFloat(form.precio_actual);
      if (isNaN(p) || p < 0) return "Precio inválido";
    }
    return null;
  };

  const buildPayload = () => ({
    nombre: form.nombre.trim(),
    proveedor_id: form.proveedor_id ? parseInt(form.proveedor_id) : null,
    insumo_id: parseInt(form.insumo_id),
    unidad_compra: form.unidad_compra,
    factor_conversion: parseFloat(form.factor_conversion),
    // merma_pct DEPRECADO: la merma/rendimiento vive en la línea de receta.
    // Se manda 0 fijo para filas nuevas (la columna sigue existiendo).
    merma_pct: 0,
    precio_actual: form.precio_actual ? parseFloat(form.precio_actual) : null,
    notas: form.notas.trim() || null,
    activa: form.activa,
  });

  const { run: crear, isPending: creando } = useGuardedHandler(async () => {
    const err = validar();
    if (err) { showError(err); return; }
    const payload = {
      ...buildPayload(),
      tenant_id: user.tenant_id,
      created_by: user.id,
      ...(form.precio_actual ? { precio_actualizado_at: new Date().toISOString() } : {}),
    };
    const { error } = await db.from("materias_primas").insert([payload]);
    if (error) { showError("No se pudo crear: " + error.message); return; }
    showToast("Materia prima creada");
    setModalNew(false);
    setForm(emptyForm);
    await load();
  });

  const { run: actualizar, isPending: actualizando } = useGuardedHandler(async () => {
    if (!modalEdit) return;
    const err = validar();
    if (err) { showError(err); return; }
    const precioNuevo = form.precio_actual ? parseFloat(form.precio_actual) : null;
    const precioCambio = precioNuevo != null && precioNuevo !== Number(modalEdit.precio_actual ?? 0);
    const payload = {
      ...buildPayload(),
      updated_by: user.id,
      ...(precioCambio ? { precio_actualizado_at: new Date().toISOString() } : {}),
    };
    const { error } = await db.from("materias_primas").update(payload).eq("id", modalEdit.id);
    if (error) { showError("No se pudo guardar: " + error.message); return; }
    showToast("Materia prima actualizada");
    setModalEdit(null);
    await load();
  });

  const { run: archivar, isPending: archivando } = useGuardedHandler(async () => {
    if (!modalEdit) return;
    if (!confirm(`¿Archivar "${modalEdit.nombre}"? No se borra, solo deja de aparecer en listados.`)) return;
    const { error } = await db.from("materias_primas").update({
      deleted_at: new Date().toISOString(),
      updated_by: user.id,
    }).eq("id", modalEdit.id);
    if (error) { showError("No se pudo archivar: " + error.message); return; }
    showToast("Materia prima archivada");
    setModalEdit(null);
    await load();
  });

  // Quick-create insumo inline. Crea el insumo, refresca lista, lo
  // selecciona en el form de la MP, cierra el mini-modal.
  const { run: crearInsumoQuick, isPending: creandoInsumo } = useGuardedHandler(async () => {
    if (!quickInsumoForm.nombre.trim()) { showError("Ponele un nombre al insumo"); return; }
    const { data, error } = await db.from("insumos").insert([{
      tenant_id: user.tenant_id,
      created_by: user.id,
      nombre: quickInsumoForm.nombre.trim(),
      unidad: quickInsumoForm.unidad,
      activo: true,
      es_comprado: true,
      stock_disponible: true,
    }]).select("id").single();
    if (error || !data) { showError("No se pudo crear el insumo: " + (error?.message ?? "vacío")); return; }
    showToast("Insumo creado");
    // Re-cargar insumos y seleccionar el nuevo en el form de la MP
    const { data: nuevos } = await db.from("insumos")
      .select("id, nombre, unidad")
      .eq("activo", true).is("deleted_at", null).order("nombre");
    setInsumos((nuevos || []) as Insumo[]);
    setForm({ ...form, insumo_id: String(data.id) });
    setQuickInsumoOpen(false);
    setQuickInsumoForm({ nombre: "", unidad: "kg" });
  });

  // Cálculo de costo por unidad del insumo (vista útil al usuario)
  const calcPrecioPorUnidadInsumo = (precio: string | number, factor: string | number) => {
    const p = Number(precio);
    const f = Number(factor);
    if (!p || !f) return null;
    return p / f;
  };

  return (
    <div>
      <ToastComponent toast={toast} />
      {!embedded && (
        <div className="ph-row">
          <div>
            <div className="ph-title">Materias primas</div>
            <div style={{ color: "var(--muted2)", fontSize: 12, marginTop: 2 }}>
              Catálogo de "qué te vende cada proveedor en qué unidad de compra" · {total} activas
              {sinPrecio > 0 && <> · <span style={{ color: "var(--warn)" }}>{sinPrecio} sin precio</span></>}
              {sinProveedor > 0 && <> · <span style={{ color: "var(--warn)" }}>{sinProveedor} sin proveedor</span></>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {puedeEditar && (
              <button className="btn btn-acc" onClick={abrirNuevo} disabled={sinInsumos} title={sinInsumos ? "Cargá insumos primero" : ""}>
                + Nueva materia prima
              </button>
            )}
          </div>
        </div>
      )}

      {/* Banner informativo si no hay materias primas */}
      {mps.length === 0 && !loading && (
        <div style={{
          marginBottom: 12,
          padding: "10px 14px",
          background: "rgba(110, 181, 255, 0.08)",
          border: "1px solid rgba(110, 181, 255, 0.3)",
          borderRadius: 6,
          fontSize: 12,
          color: "var(--muted2)",
        }}>
          <strong style={{ color: "var(--celeste)" }}>¿Qué son las materias primas?</strong> Es el catálogo de productos que te vende cada proveedor en su <em>unidad de compra</em>.
          Ej: el proveedor te vende "Bolsa salmón 5kg" → esa es una materia prima con factor=5 vinculada al insumo "Salmón" (kg).
          Al cargar una factura con esta materia prima, automáticamente entran 5kg al stock por cada bolsa que compraste.
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
          <select value={filtroProv} onChange={e => setFiltroProv(e.target.value)} className="search" style={{ width: 220 }}>
            <option value="__all">Todos los proveedores</option>
            {provsConMP.map(p => <option key={p.id} value={String(p.id)}>{p.nombre}</option>)}
            <option value="__sin">Sin proveedor</option>
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={verInactivas} onChange={e => setVerInactivas(e.target.checked)} />
            Ver inactivas
          </label>
        </div>
      </div>

      {/* Tabla */}
      <div className="panel">
        {loading ? (
          <div className="loading" style={{ padding: 40 }}>Cargando materias primas…</div>
        ) : visible.length === 0 ? (
          <div className="empty" style={{ padding: 40 }}>
            {mps.length === 0 ? "No hay materias primas cargadas. Click '+ Nueva materia prima' para empezar." : "Ninguna materia prima coincide con los filtros."}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Proveedor</th>
                <th>Insumo</th>
                <th>Unidad compra</th>
                <th style={{ textAlign: "right" }}>Factor</th>
                <th style={{ textAlign: "right" }}>Precio</th>
                <th style={{ textAlign: "right" }}>Costo por unidad</th>
                <th>Estado</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(mp => {
                const prov = mp.proveedor_id ? provById.get(mp.proveedor_id) : null;
                const ins = insById.get(mp.insumo_id);
                const costoPorUnidad = calcPrecioPorUnidadInsumo(mp.precio_actual ?? 0, mp.factor_conversion);
                return (
                  <tr key={mp.id} style={{ opacity: mp.activa ? 1 : 0.45 }}>
                    <td style={{ fontWeight: 500 }}>{mp.nombre}</td>
                    <td>
                      {prov ? (
                        <span style={{ fontSize: 12 }}>{prov.nombre}</span>
                      ) : (
                        <span className="badge b-warn" style={{ fontSize: 10 }}>Sin prov.</span>
                      )}
                    </td>
                    <td>
                      {ins ? (
                        <span style={{ fontSize: 12 }}>{ins.nombre} <span style={{ color: "var(--muted2)", fontSize: 10 }}>({ins.unidad})</span></span>
                      ) : (
                        <span className="badge b-danger" style={{ fontSize: 10 }}>Insumo borrado</span>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>{mp.unidad_compra}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{Number(mp.factor_conversion).toFixed(2)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {mp.precio_actual ? fmt_$(Number(mp.precio_actual)) : <span style={{ color: "var(--warn)" }}>—</span>}
                    </td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--muted2)" }}>
                      {costoPorUnidad != null ? (
                        <>
                          {fmt_$(costoPorUnidad)} <span style={{ fontSize: 9 }}>/{ins?.unidad ?? "u"}</span>
                        </>
                      ) : "—"}
                    </td>
                    <td>
                      {mp.activa ? <span className="badge b-success" style={{ fontSize: 10 }}>Activa</span> : <span className="badge b-muted" style={{ fontSize: 10 }}>Inactiva</span>}
                    </td>
                    <td>
                      {puedeEditar && (
                        <button className="btn btn-ghost btn-sm" onClick={() => abrirEditar(mp)}>Editar</button>
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
        title="Nueva materia prima"
        maxWidth={620}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setModalNew(false)} disabled={creando}>Cancelar</button>
            <button className="btn btn-acc" onClick={() => crear()} disabled={creando}>
              {creando ? "Guardando…" : "Crear"}
            </button>
          </>
        }
      >
        <FormFields form={form} setForm={setForm} proveedores={proveedores} insumos={insumos} onCreateInsumo={() => setQuickInsumoOpen(true)} />
      </Modal>

      {/* Modal Edición */}
      <Modal
        isOpen={!!modalEdit}
        onClose={() => setModalEdit(null)}
        title={modalEdit ? `Editar: ${modalEdit.nombre}` : ""}
        maxWidth={620}
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
        <FormFields form={form} setForm={setForm} proveedores={proveedores} insumos={insumos} onCreateInsumo={() => setQuickInsumoOpen(true)} />
        {modalEdit && modalEdit.precio_actualizado_at && (
          <div style={{ marginTop: 12, padding: 8, background: "var(--s2)", borderRadius: 4, fontSize: 11, color: "var(--muted2)" }}>
            Último cambio de precio: {new Date(modalEdit.precio_actualizado_at).toLocaleDateString("es-AR")}
          </div>
        )}
      </Modal>

      {/* Mini-Modal: crear insumo rápido sin salir del flow de MP */}
      <Modal
        isOpen={quickInsumoOpen}
        onClose={() => setQuickInsumoOpen(false)}
        title="Crear insumo rápido"
        maxWidth={420}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setQuickInsumoOpen(false)} disabled={creandoInsumo}>Cancelar</button>
            <button className="btn btn-acc" onClick={() => crearInsumoQuick()} disabled={creandoInsumo}>
              {creandoInsumo ? "Creando…" : "Crear"}
            </button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 11, color: "var(--muted2)" }}>
            El insumo es la <strong>materia base</strong> (ej: "Salmón", "Coca-Cola 500ml"). Después podés cargarle el detalle completo desde Stock → Insumos.
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--muted2)" }}>Nombre *</label>
            <input
              type="text"
              value={quickInsumoForm.nombre}
              onChange={e => setQuickInsumoForm({ ...quickInsumoForm, nombre: e.target.value })}
              placeholder="Ej: Salmón / Coca-Cola"
              className="search"
              style={{ width: "100%" }}
              autoFocus
            />
          </div>
          <div>
            <label style={{ fontSize: 11, color: "var(--muted2)" }}>Unidad base *</label>
            <select
              value={quickInsumoForm.unidad}
              onChange={e => setQuickInsumoForm({ ...quickInsumoForm, unidad: e.target.value })}
              className="search"
              style={{ width: "100%" }}
            >
              <option value="kg">kg</option>
              <option value="g">g</option>
              <option value="L">L</option>
              <option value="ml">ml</option>
              <option value="un">un</option>
              <option value="docena">docena</option>
            </select>
            <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 2 }}>
              Unidad en la que medís el stock (no la unidad de compra del proveedor).
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ─── FormFields (compartido entre Nuevo + Editar) ────────────────────────────
function FormFields({
  form, setForm, proveedores, insumos, onCreateInsumo,
}: {
  form: Form;
  setForm: (f: Form) => void;
  proveedores: Proveedor[];
  insumos: Insumo[];
  onCreateInsumo?: () => void;
}) {
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const insumoSel = insumos.find(i => String(i.id) === form.insumo_id);
  const costoUnidad = (() => {
    const p = parseFloat(form.precio_actual);
    const f = parseFloat(form.factor_conversion);
    if (!p || !f) return null;
    return p / f;
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label style={{ fontSize: 11, color: "var(--muted2)" }}>Nombre *</label>
        <input
          type="text"
          value={form.nombre}
          onChange={e => set("nombre", e.target.value)}
          placeholder="Ej: Bolsa salmón 5kg / Caja Coca-Cola 12u"
          className="search"
          style={{ width: "100%" }}
          autoFocus
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <label style={{ fontSize: 11, color: "var(--muted2)" }}>Proveedor</label>
          <select value={form.proveedor_id} onChange={e => set("proveedor_id", e.target.value)} className="search" style={{ width: "100%" }}>
            <option value="">Sin asignar</option>
            {proveedores.map(p => <option key={p.id} value={String(p.id)}>{p.nombre}</option>)}
          </select>
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <label style={{ fontSize: 11, color: "var(--muted2)" }}>Insumo vinculado *</label>
            {onCreateInsumo && (
              <button
                type="button"
                onClick={onCreateInsumo}
                style={{ fontSize: 10, color: "var(--acc)", background: "none", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}
              >
                + Crear insumo
              </button>
            )}
          </div>
          <select value={form.insumo_id} onChange={e => set("insumo_id", e.target.value)} className="search" style={{ width: "100%" }}>
            <option value="">Seleccionar insumo</option>
            {insumos.map(i => <option key={i.id} value={String(i.id)}>{i.nombre} ({i.unidad})</option>)}
          </select>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <label style={{ fontSize: 11, color: "var(--muted2)" }}>Unidad de compra *</label>
          <input
            type="text"
            list="unidades-compra-list"
            value={form.unidad_compra}
            onChange={e => set("unidad_compra", e.target.value)}
            className="search"
            style={{ width: "100%" }}
          />
          <datalist id="unidades-compra-list">
            {UNIDADES_COMPRA.map(u => <option key={u} value={u} />)}
          </datalist>
        </div>
        <div>
          <label style={{ fontSize: 11, color: "var(--muted2)" }}>Factor *</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={form.factor_conversion}
            onChange={e => set("factor_conversion", e.target.value)}
            className="search"
            style={{ width: "100%" }}
          />
          <div style={{ fontSize: 9, color: "var(--muted2)", marginTop: 2 }}>
            {insumoSel ? `Cuántos ${insumoSel.unidad} por ${form.unidad_compra || "unidad"}` : "Cantidad por unidad de compra"}
          </div>
        </div>
      </div>

      <div style={{ fontSize: 10, color: "var(--muted2)", background: "var(--bg2)", borderRadius: 6, padding: "6px 8px", lineHeight: 1.4 }}>
        💡 El costo del insumo es <b>as-bought</b> (precio ÷ factor). La <b>merma o rendimiento</b>
        {" "}(fileteado, limpieza, prep) se carga en cada <b>línea de receta</b>, no acá — así no se cuenta dos veces.
      </div>

      <div>
        <label style={{ fontSize: 11, color: "var(--muted2)" }}>Precio actual (por unidad de compra)</label>
        <input
          type="number"
          step="0.01"
          value={form.precio_actual}
          onChange={e => set("precio_actual", e.target.value)}
          placeholder="0.00"
          className="search"
          style={{ width: "100%" }}
        />
        {costoUnidad != null && insumoSel && (
          <div style={{ fontSize: 10, color: "var(--celeste)", marginTop: 4 }}>
            = {fmt_$(costoUnidad)} por {insumoSel.unidad} de {insumoSel.nombre}
          </div>
        )}
      </div>

      <div>
        <label style={{ fontSize: 11, color: "var(--muted2)" }}>Notas (opcional)</label>
        <textarea
          value={form.notas}
          onChange={e => set("notas", e.target.value)}
          placeholder="Código del proveedor, marca preferida, etc."
          className="search"
          style={{ width: "100%", minHeight: 50, resize: "vertical" }}
        />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: 8, background: "var(--s2)", borderRadius: 4 }}>
        <input type="checkbox" checked={form.activa} onChange={e => set("activa", e.target.checked)} />
        Activa
      </label>
    </div>
  );
}
