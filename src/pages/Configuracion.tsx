import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { tienePermiso } from "../lib/auth";
import { useMediosCobro, type MedioCobro } from "../lib/useMediosCobro";
import { CUENTAS } from "../lib/constants";

const TIPOS = [
  { id: "gasto_fijo", label: "Gastos Fijos" },
  { id: "gasto_variable", label: "Gastos Variables" },
  { id: "gasto_publicidad", label: "Publicidad y MKT" },
  { id: "gasto_impuesto", label: "Impuestos" },
  { id: "gasto_comision", label: "Comisiones" },
  { id: "medio_cobro", label: "Medios de Cobro" },
  { id: "cat_compra", label: "Categorías de Compra" },
];

export default function Configuracion({ user, locales }: { user: any; locales?: any[] }) {
  const [tab, setTab] = useState("gasto_fijo");
  const [items, setItems] = useState<any[]>([]);
  const [nuevo, setNuevo] = useState("");
  const [loading, setLoading] = useState(false);

  // El tab "medio_cobro" usa la tabla medios_cobro (refactor C), no
  // config_categorias — tiene su propio panel con CRUD multi-campo.
  const esMediosCobroTab = tab === "medio_cobro";

  const load = async () => {
    if (esMediosCobroTab) return; // ese tab maneja su propia data
    setLoading(true);
    const { data } = await db.from("config_categorias")
      .select("*").eq("tipo", tab).eq("activo", true).order("orden");
    setItems(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [tab]);

  const agregar = async () => {
    if (!nuevo.trim()) return;
    const nombre = nuevo.trim().toUpperCase();
    const maxOrden = items.length > 0 ? Math.max(...items.map(i => i.orden)) + 1 : 1;
    await db.from("config_categorias").insert([{ tipo: tab, nombre, orden: maxOrden, activo: true }]);
    setNuevo("");
    load();
  };

  const eliminar = async (item: any) => {
    const tipoGasto = tab.startsWith("gasto_") ? tab.replace("gasto_", "") : null;
    if (tipoGasto) {
      const { count } = await db.from("gastos").select("*", { count: "exact", head: true }).eq("categoria", item.nombre);
      if (count && count > 0) {
        if (!confirm(`"${item.nombre}" tiene ${count} movimientos registrados. ¿Igual eliminás?`)) return;
      }
    }
    await db.from("config_categorias").update({ activo: false }).eq("id", item.id);
    load();
  };

  if (!tienePermiso(user, "configuracion")) {
    return <div className="empty">No tenés permisos para acceder a esta sección.</div>;
  }

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Configuración</div></div>
      </div>
      <div className="tabs">
        {TIPOS.map(t => (
          <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</div>
        ))}
      </div>
      {esMediosCobroTab ? (
        <MediosCobroSection user={user} locales={locales || []} />
      ) : (
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">{TIPOS.find(t => t.id === tab)?.label}</span>
          </div>
          <div style={{ padding: "12px 16px" }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <input
                className="search"
                style={{ flex: 1 }}
                value={nuevo}
                onChange={e => setNuevo(e.target.value)}
                onKeyDown={e => e.key === "Enter" && agregar()}
                placeholder="Nuevo concepto..."
              />
              <button className="btn btn-acc" onClick={agregar}>+ Agregar</button>
            </div>
            {loading ? <div className="loading">Cargando...</div> : (
              <table>
                <thead><tr><th>Nombre</th><th></th></tr></thead>
                <tbody>
                  {items.map(item => (
                    <tr key={item.id}>
                      <td>{item.nombre}</td>
                      <td style={{ textAlign: "right" }}>
                        <button className="btn btn-danger btn-sm" onClick={() => eliminar(item)}>Eliminar</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// CRUD de medios_cobro (tabla nueva del refactor C). Usa el hook
// useMediosCobro para refrescar el cache global cuando cambia algo, así
// los dropdowns en Ventas/Maxirest/etc se enteran sin refresh manual.
function MediosCobroSection({ user, locales }: { user: any; locales: any[] }) {
  const { todosLosMedios, refresh, loading: hookLoading } = useMediosCobro();
  const [editing, setEditing] = useState<Partial<MedioCobro> | null>(null);
  const [saving, setSaving] = useState(false);

  // Filtrar locales visibles para el usuario. Dueño/admin ven todos.
  const localesVisibles = (user?.rol === "dueno" || user?.rol === "admin")
    ? locales
    : locales.filter(l => Array.isArray(user?._locales) && user._locales.includes(l.id));

  const items = todosLosMedios()
    .slice()
    .sort((a, b) => {
      // Globales primero, luego por orden
      if ((a.local_id == null) !== (b.local_id == null)) return a.local_id == null ? -1 : 1;
      return (a.orden || 0) - (b.orden || 0);
    });

  const nombreLocal = (id: number | null): string => {
    if (id == null) return "Global";
    return locales.find(l => l.id === id)?.nombre || `Local #${id}`;
  };

  const abrirNuevo = () => setEditing({ nombre: "", local_id: null, cuenta_destino: null, activo: true, orden: (items.length + 1) });
  const abrirEditar = (m: MedioCobro) => setEditing({ ...m });

  const toggleActivo = async (m: MedioCobro) => {
    setSaving(true);
    const { error } = await db.from("medios_cobro").update({ activo: !m.activo, updated_at: new Date().toISOString() }).eq("id", m.id);
    if (error) {
      alert("No se pudo actualizar: " + error.message);
    } else {
      refresh();
    }
    setSaving(false);
  };

  const guardar = async () => {
    if (!editing) return;
    const nombre = (editing.nombre || "").trim();
    if (!nombre) { alert("Nombre obligatorio"); return; }
    setSaving(true);
    const payload: any = {
      nombre,
      local_id: editing.local_id ?? null,
      cuenta_destino: editing.cuenta_destino || null,
      activo: editing.activo ?? true,
      orden: editing.orden ?? 0,
      updated_at: new Date().toISOString(),
    };
    let error;
    if (editing.id && editing.id > 0) {
      ({ error } = await db.from("medios_cobro").update(payload).eq("id", editing.id));
    } else {
      ({ error } = await db.from("medios_cobro").insert([payload]));
    }
    setSaving(false);
    if (error) {
      // UNIQUE (nombre, local_id) → mensaje friendly
      if (String(error.message).includes("medios_cobro_nombre_local_id_key")) {
        alert(`Ya existe un medio "${nombre}" para ${nombreLocal(payload.local_id)}.`);
      } else {
        alert("No se pudo guardar: " + error.message);
      }
      return;
    }
    setEditing(null);
    refresh();
  };

  return (
    <>
      <div className="panel">
        <div className="panel-hd">
          <span className="panel-title">Medios de Cobro</span>
          <button className="btn btn-acc btn-sm" onClick={abrirNuevo}>+ Nuevo medio</button>
        </div>
        <div style={{ padding: "12px 16px" }}>
          {hookLoading ? <div className="loading">Cargando...</div> : (
            <table>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Local</th>
                  <th>Cuenta destino</th>
                  <th style={{ textAlign: "center" }}>Activo</th>
                  <th style={{ textAlign: "center" }}>Orden</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map(m => (
                  <tr key={m.id} style={{ opacity: m.activo ? 1 : 0.5 }}>
                    <td>{m.nombre}</td>
                    <td style={{ fontSize: 11, color: m.local_id == null ? "var(--accent)" : "var(--txt)" }}>
                      {nombreLocal(m.local_id)}
                    </td>
                    <td style={{ fontSize: 11, color: "var(--muted2)" }}>{m.cuenta_destino || "—"}</td>
                    <td style={{ textAlign: "center" }}>{m.activo ? "✓" : "—"}</td>
                    <td style={{ textAlign: "center", color: "var(--muted2)" }}>{m.orden}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn btn-sec btn-sm" disabled={saving} onClick={() => abrirEditar(m)} style={{ marginRight: 6 }}>Editar</button>
                      <button className="btn btn-sec btn-sm" disabled={saving} onClick={() => toggleActivo(m)}>
                        {m.activo ? "Desactivar" : "Reactivar"}
                      </button>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr><td colSpan={6} className="empty">Sin medios configurados</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {editing && (
        <div className="modal-overlay" onClick={() => !saving && setEditing(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <span className="panel-title">{editing.id ? "Editar medio" : "Nuevo medio"}</span>
            </div>
            <div className="modal-bd">
              <div className="field">
                <label>Nombre</label>
                <input className="search" value={editing.nombre || ""} onChange={e => setEditing({ ...editing, nombre: e.target.value })} placeholder="EFECTIVO SALON, RAPPI ONLINE, etc"/>
              </div>
              <div className="field">
                <label>Local</label>
                <select className="search" value={editing.local_id == null ? "" : String(editing.local_id)} onChange={e => setEditing({ ...editing, local_id: e.target.value === "" ? null : Number(e.target.value) })}>
                  <option value="">Global (todos los locales)</option>
                  {localesVisibles.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Cuenta destino (impacta caja al ingresar venta)</label>
                <select className="search" value={editing.cuenta_destino || ""} onChange={e => setEditing({ ...editing, cuenta_destino: e.target.value || null })}>
                  <option value="">Ninguna (no impacta caja)</option>
                  {CUENTAS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", gap: 16 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>Orden</label>
                  <input type="number" className="search" value={editing.orden ?? 0} onChange={e => setEditing({ ...editing, orden: Number(e.target.value) || 0 })}/>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>Activo</label>
                  <select className="search" value={editing.activo ? "1" : "0"} onChange={e => setEditing({ ...editing, activo: e.target.value === "1" })}>
                    <option value="1">Sí</option>
                    <option value="0">No</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setEditing(null)} disabled={saving}>Cancelar</button>
              <button className="btn btn-acc" onClick={guardar} disabled={saving}>{saving ? "Guardando..." : "Guardar"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
