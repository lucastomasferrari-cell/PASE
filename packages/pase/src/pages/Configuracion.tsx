import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { tienePermiso } from "../lib/auth";
import { useMediosCobro, type MedioCobro } from "../lib/useMediosCobro";
import { useCategorias } from "../lib/useCategorias";
import { useRealtimeTable } from "../lib/useRealtimeTable";
import { CUENTAS } from "../lib/constants";
import type { Usuario, Local } from "../types";

interface ConfigCategoriaItem {
  id: number;
  tipo: string;
  nombre: string;
  orden: number;
  activo: boolean;
  grupo: string | null;
}

interface ConfiguracionProps {
  user: Usuario | null;
  locales?: Local[];
  // Local activo del sidebar — usado por MediosCobroSection para filtrar
  // el catálogo por defecto (globales + del local activo). Dueño/admin/
  // superadmin pueden override con el toggle "Mostrar todos los locales".
  localActivo: number | null;
}

interface MediosCobroSectionProps {
  user: Usuario | null;
  locales: Local[];
  localActivo: number | null;
}

// Payload de insert/update sobre medios_cobro: Omite id (lo asigna la DB)
// y permite que algunos campos vengan opcionales del Partial<MedioCobro>.
type MedioCobroPayload = Omit<MedioCobro, "id"> & { updated_at: string };

const TIPOS = [
  // "categorias_gastos" es un tab virtual que agrupa los 5 tipos de gasto en
  // una sola tabla con columna "Tipo" editable. No es un valor real en la
  // columna config_categorias.tipo — solo identifica el tab en la UI.
  { id: "categorias_gastos", label: "Categorías de Gastos" },
  { id: "cat_compra", label: "Categorías de Compra" },
  { id: "cat_ingreso", label: "Categorías de Ingreso" },
  { id: "medio_cobro", label: "Medios de Cobro" },
];

// Sub-tipos que viven bajo el tab unificado "Categorías de Gastos".
// retiro_socio NO es gasto operativo (es distribución de utilidades) pero
// se administra acá porque la salida de plata sigue siendo via la pantalla
// Gastos. EERR los muestra en sección post-Util.Neta.
const TIPOS_GASTO: { id: string; label: string }[] = [
  { id: "gasto_fijo", label: "Fijo" },
  { id: "gasto_variable", label: "Variable" },
  { id: "gasto_publicidad", label: "Publicidad" },
  { id: "gasto_comision", label: "Comisión" },
  { id: "gasto_impuesto", label: "Impuesto" },
  { id: "retiro_socio", label: "Retiro de Socios" },
];
const TIPOS_GASTO_IDS = TIPOS_GASTO.map(t => t.id);

export default function Configuracion({ user, locales, localActivo }: ConfiguracionProps) {
  const [tab, setTab] = useState("categorias_gastos");
  const [items, setItems] = useState<ConfigCategoriaItem[]>([]);
  const [nuevo, setNuevo] = useState("");
  // Tipo de gasto seleccionado en el form de "Agregar" cuando estamos en el
  // tab unificado "Categorías de Gastos". Se ignora en los otros tabs.
  const [nuevoTipoGasto, setNuevoTipoGasto] = useState<string>("gasto_fijo");
  const [loading, setLoading] = useState(false);

  // El tab "medio_cobro" usa la tabla medios_cobro (refactor C), no
  // config_categorias — tiene su propio panel con CRUD multi-campo.
  const esMediosCobroTab = tab === "medio_cobro";
  // Tab unificado de Gastos: agrupa los 5 sub-tipos. Cada categoría tiene
  // un tipo (Fijo/Variable/Publicidad/Comisión/Impuesto) editable inline.
  const esCategoriasGastosTab = tab === "categorias_gastos";
  // Para cat_ingreso preservamos el casing tal como Lucas lo escribe
  // (las existentes son "Liquidación X", "Ingreso Socio", etc en mixed
  // case). Para los otros tipos seguimos forzando UPPERCASE como antes.
  const preservarCasing = tab === "cat_ingreso";

  // refresh() invalida el cache de useCategorias en sessionStorage para
  // que los dropdowns en Caja/Ventas/etc se enteren del cambio sin reload.
  const { refresh: refreshCategorias } = useCategorias();

  const load = async () => {
    if (esMediosCobroTab) return; // ese tab maneja su propia data
    setLoading(true);
    const q = db.from("config_categorias").select("*").eq("activo", true).order("orden");
    const { data } = esCategoriasGastosTab
      ? await q.in("tipo", TIPOS_GASTO_IDS)
      : await q.eq("tipo", tab);
    setItems((data as ConfigCategoriaItem[]) || []);
    setLoading(false);
  };

  // Patrón fetch-on-dep-change. No agregar load a deps (re-fetch infinito).
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [tab]);

  // Sprint Realtime: cualquier cambio remoto en config_categorias del
  // mismo tenant dispara reload de la sección Categorías. El refresh
  // del hook useCategorias también se invalida tras detectar el cambio
  // (corre en otros componentes — no acá, su effect lo maneja).
  useRealtimeTable({
    table: 'config_categorias',
    onChange: () => { load(); refreshCategorias(); },
    enabled: !esMediosCobroTab,
  });

  const agregar = async () => {
    if (!nuevo.trim()) return;
    const nombre = preservarCasing ? nuevo.trim() : nuevo.trim().toUpperCase();
    const tipoARegistrar = esCategoriasGastosTab ? nuevoTipoGasto : tab;
    const maxOrden = items.length > 0 ? Math.max(...items.map(i => i.orden)) + 1 : 1;
    await db.from("config_categorias").insert([{ tipo: tipoARegistrar, nombre, orden: maxOrden, activo: true }]);
    setNuevo("");
    await refreshCategorias();
    load();
  };

  // Cambia el sub-tipo de una categoría existente. Solo aplica en el tab
  // unificado de Gastos (los otros tabs no permiten cambiar el tipo).
  // Importante: los gastos ya cargados con esta categoría conservan el
  // valor del campo gastos.tipo que tenían al momento de creación — solo
  // futuros gastos toman el tipo nuevo.
  const cambiarTipo = async (item: ConfigCategoriaItem, nuevoTipo: string) => {
    if (item.tipo === nuevoTipo) return;
    await db.from("config_categorias").update({ tipo: nuevoTipo }).eq("id", item.id);
    await refreshCategorias();
    load();
  };

  const eliminar = async (item: ConfigCategoriaItem) => {
    const tipoGasto = item.tipo.startsWith("gasto_") ? item.tipo.replace("gasto_", "") : null;
    if (tipoGasto) {
      // eslint-disable-next-line pase-local/require-apply-local-scope -- count cross-local intencional: warning previo a borrar una categoría compartida (config_categorias es global por tenant). Solo dueño/admin llega acá por chequeo de permiso arriba.
      const { count } = await db.from("gastos").select("*", { count: "exact", head: true }).eq("categoria", item.nombre);
      if (count && count > 0) {
        if (!confirm(`"${item.nombre}" tiene ${count} movimientos registrados. ¿Igual eliminás?`)) return;
      }
    }
    await db.from("config_categorias").update({ activo: false }).eq("id", item.id);
    await refreshCategorias();
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
        <MediosCobroSection user={user} locales={locales || []} localActivo={localActivo} />
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
              {esCategoriasGastosTab && (
                <select
                  value={nuevoTipoGasto}
                  onChange={e => setNuevoTipoGasto(e.target.value)}
                  style={{ minWidth: 130 }}
                  title="Tipo de gasto"
                >
                  {TIPOS_GASTO.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              )}
              <button className="btn btn-acc" onClick={agregar}>+ Agregar</button>
            </div>
            {loading ? <div className="loading">Cargando...</div> : (
              <table>
                <thead>
                  <tr>
                    <th>Nombre</th>
                    {esCategoriasGastosTab && <th style={{ width: 150 }}>Tipo</th>}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(esCategoriasGastosTab
                    ? [...items].sort((a, b) => {
                        // Agrupar visualmente por tipo siguiendo el orden de TIPOS_GASTO
                        // (Fijo, Variable, Publicidad, Comisión, Impuesto), después
                        // alfabético dentro del tipo.
                        const ia = TIPOS_GASTO_IDS.indexOf(a.tipo);
                        const ib = TIPOS_GASTO_IDS.indexOf(b.tipo);
                        if (ia !== ib) return ia - ib;
                        return a.nombre.localeCompare(b.nombre);
                      })
                    : items
                  ).map(item => (
                    <tr key={item.id}>
                      <td>{item.nombre}</td>
                      {esCategoriasGastosTab && (
                        <td>
                          <select
                            value={item.tipo}
                            onChange={e => cambiarTipo(item, e.target.value)}
                            style={{ fontSize: 11, padding: "4px 6px" }}
                          >
                            {TIPOS_GASTO.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                          </select>
                        </td>
                      )}
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
function MediosCobroSection({ user, locales, localActivo }: MediosCobroSectionProps) {
  const { todosLosMedios, refresh, loading: hookLoading } = useMediosCobro();
  const [editing, setEditing] = useState<Partial<MedioCobro> | null>(null);
  const [saving, setSaving] = useState(false);

  // Toggle "Mostrar todos los locales" — solo visible para dueño/admin/
  // superadmin. Default: OFF (filtra por local activo del sidebar). Persiste
  // en sessionStorage (no localStorage) para que NO sobreviva entre sesiones
  // — evita sorpresas tipo "abro la app días después y veo todos los locales
  // sin haberlo elegido".
  const puedeVerTodos = user?.rol === "dueno" || user?.rol === "admin" || user?.rol === "superadmin";
  const storageKey = user?.id ? `conceptos_mostrar_todos_locales_${user.id}` : null;
  const [mostrarTodos, setMostrarTodos] = useState<boolean>(() => {
    if (!puedeVerTodos || !storageKey) return false;
    try { return sessionStorage.getItem(storageKey) === "1"; } catch { return false; }
  });
  const toggleMostrarTodos = (v: boolean) => {
    setMostrarTodos(v);
    if (storageKey) {
      try { sessionStorage.setItem(storageKey, v ? "1" : "0"); } catch { /* sessionStorage puede fallar en modo privado */ }
    }
  };

  // Sprint Realtime: cambios remotos en medios_cobro del mismo tenant
  // disparan refresh del hook (que invalida sessionStorage + re-fetch).
  useRealtimeTable({
    table: 'medios_cobro',
    onChange: () => refresh(),
  });

  // Filtrar locales visibles para el usuario. Dueño/admin ven todos.
  const localesVisibles = (user?.rol === "dueno" || user?.rol === "admin")
    ? locales
    : locales.filter(l => Array.isArray(user?._locales) && user._locales.includes(l.id));

  // Bug 2026-05-11: la pantalla mostraba TODOS los medios del tenant (Lucas
  // veía medios de Belgrano/Palermo/Cantina estando en Villa Crespo). Fix:
  // por default filtrar por (global) + (local activo). Dueño/admin/super
  // puede destildar "Solo local activo" con el toggle para ver todos.
  const items = todosLosMedios()
    .filter(m => {
      // Si toggle ON (mostrar todos) o no puede usar el toggle (encargado):
      // mostrar solo los visibles según RLS — la RLS ya filtra para encargado
      // por (global + locales autorizados), así que para él no cambia. Para
      // dueño con toggle ON, muestra los 5 locales.
      if (mostrarTodos && puedeVerTodos) return true;
      // Default: globales + del local activo.
      return m.local_id == null || m.local_id === localActivo;
    })
    .slice()
    .sort((a, b) => {
      // Globales primero, luego por orden
      if ((a.local_id == null) !== (b.local_id == null)) return a.local_id == null ? -1 : 1;
      return (a.orden || 0) - (b.orden || 0);
    });

  const nombreLocalActivo = localActivo != null
    ? (locales.find(l => l.id === localActivo)?.nombre ?? `Local #${localActivo}`)
    : "(sin local activo)";

  const nombreLocal = (id: number | null): string => {
    if (id == null) return "Global";
    return locales.find(l => l.id === id)?.nombre || `Local #${id}`;
  };

  // Determina si la acción debe crear/usar un override por local en vez
  // de tocar la fila global. Override mode = (fila global) + (modo
  // filtrado por local activo, NO admin todos-los-locales).
  const enModoOverride = !mostrarTodos && localActivo != null;
  const esFilaGlobal = (m: MedioCobro) => m.local_id == null;
  const buscarOverride = (nombre: string) =>
    todosLosMedios().find(x => x.nombre === nombre && x.local_id === localActivo);

  const abrirNuevo = () => setEditing({ nombre: "", local_id: null, cuenta_destino: null, activo: true, orden: (items.length + 1) });

  // abrirEditar: si el clic viene sobre fila global Y estamos en modo
  // filtrado, en vez de editar el global, abrimos el modal para el
  // override del local activo. Si el override existe → editar ese. Si no
  // existe → abrir form con los datos copiados del global SIN id (al
  // guardar se va a INSERT, no UPDATE — crea el override).
  const abrirEditar = (m: MedioCobro) => {
    if (esFilaGlobal(m) && enModoOverride) {
      const override = buscarOverride(m.nombre);
      if (override) {
        setEditing({ ...override });
      } else {
        // Override nuevo: clonamos campos del global pero sin id ni local_id=null.
        // El usuario puede ajustar antes de guardar.
        setEditing({
          nombre: m.nombre,
          local_id: localActivo,
          cuenta_destino: m.cuenta_destino,
          activo: m.activo,
          orden: m.orden,
          // sin id → guardar() interpreta como INSERT.
        });
      }
      return;
    }
    setEditing({ ...m });
  };

  const toggleActivo = async (m: MedioCobro) => {
    setSaving(true);
    try {
      // Caso override: clic sobre fila global en modo filtrado.
      // En vez de tocar el global (afectaría a los 5 locales), creamos /
      // actualizamos un override solo para el local activo.
      if (esFilaGlobal(m) && enModoOverride) {
        const override = buscarOverride(m.nombre);
        if (override) {
          // El override ya existe — toggle su activo.
          const { error } = await db.from("medios_cobro")
            .update({ activo: !override.activo, updated_at: new Date().toISOString() })
            .eq("id", override.id);
          if (error) { alert("No se pudo actualizar: " + error.message); return; }
        } else {
          // Crear override nuevo con activo opuesto al global. Copiamos
          // cuenta_destino y orden para que el override sea consistente.
          const { error } = await db.from("medios_cobro").insert([{
            nombre: m.nombre,
            local_id: localActivo,
            cuenta_destino: m.cuenta_destino,
            activo: !m.activo,
            orden: m.orden,
            updated_at: new Date().toISOString(),
          }]);
          if (error) { alert("No se pudo crear override: " + error.message); return; }
        }
        refresh();
        return;
      }
      // Default: UPDATE directo sobre la fila clickeada (override local
      // existente o admin tocando el global).
      const { error } = await db.from("medios_cobro")
        .update({ activo: !m.activo, updated_at: new Date().toISOString() })
        .eq("id", m.id);
      if (error) {
        alert("No se pudo actualizar: " + error.message);
      } else {
        refresh();
      }
    } finally {
      setSaving(false);
    }
  };

  // ¿La fila es un override "genuino" de un medio Global? (es decir, hay
  // OTRA fila con el mismo nombre y local_id=null que sigue activa o no).
  // Si sí: ofrecemos botón "Volver al Global" que borra el override.
  const tieneGlobalContraparte = (m: MedioCobro): boolean =>
    m.local_id != null && todosLosMedios().some(x => x.nombre === m.nombre && x.local_id === null);

  // Borra una fila override sin tocar el Global. El local vuelve a usar
  // el medio Global tal cual (valores y estado activo del Global).
  const borrarOverride = async (m: MedioCobro) => {
    if (m.local_id == null) { alert("Esta fila no es un override (es Global)."); return; }
    if (!confirm(`¿Quitar el override de "${m.nombre}" en ${nombreLocal(m.local_id)}? Volverá a usar el medio Global.`)) return;
    setSaving(true);
    try {
      const { error } = await db.from("medios_cobro").delete().eq("id", m.id);
      if (error) { alert("No se pudo borrar el override: " + error.message); return; }
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const guardar = async () => {
    if (!editing) return;
    const nombre = (editing.nombre || "").trim();
    if (!nombre) { alert("Nombre obligatorio"); return; }
    setSaving(true);
    const payload: MedioCobroPayload = {
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
        <div className="panel-hd" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="panel-title">Medios de Cobro</span>
            {/* Indicador del scope vigente: contexto claro al operador sobre
                qué subset está viendo. */}
            {mostrarTodos && puedeVerTodos ? (
              <span className="badge b-warn" style={{ fontSize: 9, letterSpacing: 0.5 }}>
                Vista admin · todos los locales
              </span>
            ) : (
              <span style={{ fontSize: 10, color: "var(--muted2)" }}>
                Local activo: <strong style={{ color: "var(--txt)" }}>{nombreLocalActivo}</strong> + globales
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {puedeVerTodos && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, cursor: "pointer", userSelect: "none", color: "var(--muted2)" }}>
                <input type="checkbox" checked={mostrarTodos} onChange={e => toggleMostrarTodos(e.target.checked)} style={{ cursor: "pointer" }} />
                Mostrar todos los locales
              </label>
            )}
            <button className="btn btn-acc btn-sm" onClick={abrirNuevo}>+ Nuevo medio</button>
          </div>
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
                      <button className="btn btn-sec btn-sm" disabled={saving} onClick={() => toggleActivo(m)} style={{ marginRight: tieneGlobalContraparte(m) ? 6 : 0 }}>
                        {m.activo ? "Desactivar" : "Reactivar"}
                      </button>
                      {tieneGlobalContraparte(m) && (
                        <button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => borrarOverride(m)} title="Borra el override y vuelve a usar el medio Global tal cual">
                          Volver al Global
                        </button>
                      )}
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
      {editing && (() => {
        // ¿Estamos creando un override nuevo? (sin id + local_id == localActivo
        // + estamos en modo filtrado por local). Útil para mostrar banner.
        const esOverrideNuevo = !editing.id && enModoOverride && editing.local_id === localActivo;
        // ¿Estamos editando un override existente (override-row local-specific
        // y el toggle está en modo filtrado)? También vale el banner.
        const esOverrideExistente = !!editing.id && editing.local_id != null && editing.local_id === localActivo && enModoOverride;
        return (
        <div className="modal-overlay" onClick={() => !saving && setEditing(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <span className="panel-title">{editing.id ? "Editar medio" : (esOverrideNuevo ? `Override en ${nombreLocalActivo}` : "Nuevo medio")}</span>
            </div>
            <div className="modal-bd">
              {(esOverrideNuevo || esOverrideExistente) && (
                <div className="alert alert-warn" style={{ marginBottom: 12, fontSize: 11, lineHeight: 1.5 }}>
                  {esOverrideNuevo ? (
                    <>Vas a crear un <strong>override solo para {nombreLocalActivo}</strong> del medio Global &quot;{editing.nombre}&quot;. Los otros locales no se afectan. Si querés modificar el medio Global directamente, cancelá, prendé el toggle &quot;Mostrar todos los locales&quot; y editá la fila Global.</>
                  ) : (
                    <>Estás editando el <strong>override de {nombreLocalActivo}</strong>. Los cambios afectan solo a este local.</>
                  )}
                </div>
              )}
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
        );
      })()}
    </>
  );
}
