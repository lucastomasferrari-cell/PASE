import { useState, useEffect, useMemo } from "react";
import { db } from "../lib/supabase";
import { Modal } from "../components/ui";
import styles from "./Ajustes.module.css";

// ─────────────────────────────────────────────────────────────────────
// Pantalla Ajustes — rediseño sprint v2 cosmético.
// Reemplaza la vista de 5 tabs (Categorías Gastos / Compras / Ingreso /
// Medios de Cobro / Puestos RRHH) por 6 grupos colapsables con búsqueda
// global, sentence case, y pill Fijo/Variable inline.
//
// Datos: lectura directa de config_categorias / medios_cobro /
// rrhh_puestos. No cambia el schema. Filtra activo=true.
// ─────────────────────────────────────────────────────────────────────

interface CategoriaRow { tipo: string; nombre: string; orden: number; grupo: string | null; activo: boolean }
interface MedioCobroRow { id: number; nombre: string; cuenta_destino: string | null; activo: boolean }
interface PuestoRow { id: number; nombre: string; activo: boolean }

type GrupoId = "gastos" | "compras" | "ingresos" | "medios" | "puestos" | "turnos";
type TipoGasto = "fijo" | "variable";

// Sub-tipos de "Categorías de gastos" para mostrar pill Fijo/Variable.
const TIPOS_GASTO_FIJO = ["gasto_fijo", "gasto_publicidad", "gasto_comision", "gasto_impuesto", "retiro_socio"];
const TIPOS_GASTO_VARIABLE = ["gasto_variable"];
const TIPOS_GASTO_TODOS = [...TIPOS_GASTO_FIJO, ...TIPOS_GASTO_VARIABLE];

const STORAGE_KEY = "pase-ajustes-expanded";

function loadExpanded(): Set<GrupoId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* localStorage bloqueado */ }
  return new Set(["gastos"]); // primer grupo expandido por default
}

function saveExpanded(s: Set<GrupoId>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(s))); }
  catch { /* idem */ }
}

// Sentence case: primera letra mayúscula, resto lower. NO cambia palabras
// con tildes ni paréntesis — preserva el contenido como vino.
function sentenceCase(s: string): string {
  const t = s.trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

// Resalta el texto que matchea la búsqueda con un span de background tenue.
function highlight(text: string, q: string): React.ReactNode {
  if (!q.trim()) return text;
  const lower = text.toLowerCase();
  const qLower = q.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className={styles.itemMatch}>{text.slice(idx, idx + q.length)}</span>
      {text.slice(idx + q.length)}
    </>
  );
}

const IconChevron = (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="5,3 9,7 5,11"/>
  </svg>
);

const IconPlus = (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="7" y1="2" x2="7" y2="12"/>
    <line x1="2" y1="7" x2="12" y2="7"/>
  </svg>
);

interface GrupoSpec {
  id: GrupoId;
  label: string;
  iconChar: string;
}

const GRUPOS_DEF: GrupoSpec[] = [
  { id: "gastos",   label: "Categorías de gastos",    iconChar: "▼" },
  { id: "compras",  label: "Categorías de compras",   iconChar: "▼" },
  { id: "ingresos", label: "Categorías de ingresos",  iconChar: "▲" },
  { id: "medios",   label: "Medios de cobro",         iconChar: "■" },
  { id: "puestos",  label: "Puestos del equipo",      iconChar: "●" },
  { id: "turnos",   label: "Turnos y horarios",       iconChar: "◷" },
];

export default function Ajustes() {
  const [loading, setLoading] = useState(true);
  const [categorias, setCategorias] = useState<CategoriaRow[]>([]);
  const [medios, setMedios] = useState<MedioCobroRow[]>([]);
  const [puestos, setPuestos] = useState<PuestoRow[]>([]);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<GrupoId>>(loadExpanded);
  const [nuevoModalGrupo, setNuevoModalGrupo] = useState<GrupoId | null>(null);
  const [nuevoNombre, setNuevoNombre] = useState("");
  const [nuevoTipoGasto, setNuevoTipoGasto] = useState<TipoGasto>("fijo");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const [cats, mes, pus] = await Promise.all([
      db.from("config_categorias").select("tipo,nombre,orden,grupo,activo").eq("activo", true),
      db.from("medios_cobro").select("id,nombre,cuenta_destino,activo").eq("activo", true),
      db.from("rrhh_puestos").select("id,nombre,activo").eq("activo", true),
    ]);
    setCategorias((cats.data as CategoriaRow[]) || []);
    setMedios((mes.data as MedioCobroRow[]) || []);
    setPuestos((pus.data as PuestoRow[]) || []);
    setLoading(false);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  // Persistir expandidos
  useEffect(() => { saveExpanded(expanded); }, [expanded]);

  const toggleGrupo = (id: GrupoId) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Cuando hay búsqueda activa, auto-expandimos todos los grupos con matches.
  const searchActive = search.trim().length > 0;
  const matches = (txt: string) => txt.toLowerCase().includes(search.toLowerCase());

  // ─── Items por grupo (filtrados) ──────────────────────────────────
  const itemsGastos = useMemo(
    () => categorias
      .filter(c => TIPOS_GASTO_TODOS.includes(c.tipo))
      .filter(c => !searchActive || matches(c.nombre))
      .sort((a, b) => a.nombre.localeCompare(b.nombre)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [categorias, search],
  );
  const itemsCompras = useMemo(
    () => categorias
      .filter(c => c.tipo === "cat_compra")
      .filter(c => !searchActive || matches(c.nombre))
      .sort((a, b) => a.nombre.localeCompare(b.nombre)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [categorias, search],
  );
  const itemsIngresos = useMemo(
    () => categorias
      .filter(c => c.tipo === "cat_ingreso")
      .filter(c => !searchActive || matches(c.nombre))
      .sort((a, b) => a.nombre.localeCompare(b.nombre)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [categorias, search],
  );
  const itemsMedios = useMemo(
    () => medios
      .filter(m => !searchActive || matches(m.nombre))
      .sort((a, b) => a.nombre.localeCompare(b.nombre)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [medios, search],
  );
  const itemsPuestos = useMemo(
    () => puestos
      .filter(p => !searchActive || matches(p.nombre))
      .sort((a, b) => a.nombre.localeCompare(b.nombre)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [puestos, search],
  );

  const totalItems = categorias.length + medios.length + puestos.length;
  const resultadosBusqueda = itemsGastos.length + itemsCompras.length + itemsIngresos.length + itemsMedios.length + itemsPuestos.length;

  // Grupo expandido determina el contexto del botón "+ Nuevo" del header.
  const isExpanded = (id: GrupoId) => searchActive ? true : expanded.has(id);
  const expandedIds = (GRUPOS_DEF.map(g => g.id) as GrupoId[]).filter(isExpanded);
  const unicoExpandido: GrupoId | null = expandedIds.length === 1 ? expandedIds[0]! : null;

  const nuevoBtnLabel = unicoExpandido
    ? `+ Nuevo en ${GRUPOS_DEF.find(g => g.id === unicoExpandido)!.label.toLowerCase()}`
    : "+ Nuevo";

  const openNuevoModal = () => {
    setNuevoModalGrupo(unicoExpandido || "gastos");
    setNuevoNombre("");
    setNuevoTipoGasto("fijo");
  };

  const guardarNuevo = async () => {
    if (!nuevoModalGrupo || !nuevoNombre.trim() || saving) return;
    setSaving(true);
    try {
      const nombre = nuevoNombre.trim();
      let tipoDb: string | null = null;
      let table: "config_categorias" | "medios_cobro" | "rrhh_puestos" = "config_categorias";

      if (nuevoModalGrupo === "gastos") {
        tipoDb = nuevoTipoGasto === "fijo" ? "gasto_fijo" : "gasto_variable";
      } else if (nuevoModalGrupo === "compras") {
        tipoDb = "cat_compra";
      } else if (nuevoModalGrupo === "ingresos") {
        tipoDb = "cat_ingreso";
      } else if (nuevoModalGrupo === "medios") {
        table = "medios_cobro";
      } else if (nuevoModalGrupo === "puestos") {
        table = "rrhh_puestos";
      } else {
        alert("Este grupo todavía no tiene CRUD configurado.");
        setSaving(false);
        return;
      }

      let insertErr: { message: string } | null = null;
      if (table === "config_categorias") {
        const { error } = await db.from("config_categorias").insert({ nombre, tipo: tipoDb, orden: 999, activo: true });
        insertErr = error;
      } else if (table === "medios_cobro") {
        const { error } = await db.from("medios_cobro").insert({ nombre, activo: true });
        insertErr = error;
      } else if (table === "rrhh_puestos") {
        const { error } = await db.from("rrhh_puestos").insert({ nombre, activo: true });
        insertErr = error;
      }
      if (insertErr) {
        alert("No se pudo crear: " + insertErr.message);
        setSaving(false);
        return;
      }

      setNuevoModalGrupo(null);
      setNuevoNombre("");
      await load();
    } finally {
      setSaving(false);
    }
  };

  // Toggle Fijo/Variable de una categoría de gasto (sprint v2: pill inline
  // editable). Actualiza tipo en config_categorias.
  // NOTA: si la categoría tenía tipo distinto (publicidad, comision, etc.),
  // este toggle no aplica — solo afecta gasto_fijo ↔ gasto_variable. Para
  // otros sub-tipos se mantiene el tipo original.
  const toggleTipoCategoria = async (cat: CategoriaRow) => {
    const nuevoTipo = cat.tipo === "gasto_fijo" ? "gasto_variable"
                   : cat.tipo === "gasto_variable" ? "gasto_fijo"
                   : null;
    if (!nuevoTipo) return; // solo aplica al binomio fijo/variable
    // Optimistic update
    setCategorias(prev => prev.map(c =>
      (c.tipo === cat.tipo && c.nombre === cat.nombre) ? { ...c, tipo: nuevoTipo } : c
    ));
    const { error } = await db.from("config_categorias")
      .update({ tipo: nuevoTipo })
      .eq("nombre", cat.nombre)
      .eq("tipo", cat.tipo);
    if (error) {
      // Rollback
      alert("No se pudo cambiar el tipo: " + error.message);
      load();
    }
  };

  const grupoItemsCount: Record<GrupoId, number> = {
    gastos: itemsGastos.length,
    compras: itemsCompras.length,
    ingresos: itemsIngresos.length,
    medios: itemsMedios.length,
    puestos: itemsPuestos.length,
    turnos: 0,
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.titleWrap}>
          <span className={styles.title}>Ajustes</span>
          <span className={styles.subtitle}>Configuraciones del negocio · Neko</span>
        </div>
        <div className={styles.actions}>
          <button className="btn btn-acc" onClick={openNuevoModal}>
            <span style={{ width: 14, height: 14, display: "inline-flex" }}>{IconPlus}</span>
            <span style={{ marginLeft: 4 }}>{nuevoBtnLabel}</span>
          </button>
        </div>
      </div>

      <div className={styles.toolbar}>
        <input
          className="search"
          placeholder="Buscar en todas las configuraciones…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ minWidth: 280 }}
        />
        <span className={styles.toolbarCount}>
          {searchActive
            ? `${resultadosBusqueda} resultado${resultadosBusqueda === 1 ? "" : "s"}`
            : `${totalItems} items totales`}
        </span>
      </div>

      {loading ? (
        <div className="loading">Cargando…</div>
      ) : searchActive && resultadosBusqueda === 0 ? (
        <div className={styles.noResults}>
          No encontramos ningún item con &ldquo;{search}&rdquo;. Probá con otro término.
        </div>
      ) : (
        <>
          {GRUPOS_DEF.map(g => {
            const open = isExpanded(g.id);
            const count = grupoItemsCount[g.id];
            return (
              <div key={g.id} className={styles.grupo}>
                <button
                  type="button"
                  className={styles.grupoHeader}
                  onClick={() => toggleGrupo(g.id)}
                  aria-expanded={open}
                >
                  <span className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}>{IconChevron}</span>
                  <span className={styles.grupoIcon} aria-hidden>{g.iconChar}</span>
                  <span className={styles.grupoLabel}>{g.label}</span>
                  <span className={styles.grupoCount}>{count}</span>
                  <span className={styles.grupoToggleText}>{open ? "Colapsar" : "Expandir"}</span>
                </button>

                {open && (
                  <div className={styles.itemList}>
                    {g.id === "gastos" && itemsGastos.map(c => {
                      const isFijo = c.tipo === "gasto_fijo" || TIPOS_GASTO_FIJO.includes(c.tipo);
                      const togglable = c.tipo === "gasto_fijo" || c.tipo === "gasto_variable";
                      return (
                        <div key={`${c.tipo}-${c.nombre}`} className={styles.item}>
                          <span className={styles.itemNombre}>{highlight(sentenceCase(c.nombre), search)}</span>
                          <button
                            type="button"
                            className={`${styles.pillTipo} ${isFijo ? styles.pillFijo : styles.pillVariable}`}
                            onClick={() => togglable && toggleTipoCategoria(c)}
                            disabled={!togglable}
                            title={togglable ? "Click para cambiar entre Fijo y Variable" : `Tipo: ${c.tipo}`}
                          >
                            {isFijo ? "Fijo" : "Variable"}
                          </button>
                          <button className={styles.itemAccion} title="Editar (próximamente)" disabled>✏</button>
                          <button className={`${styles.itemAccion} ${styles.itemAccionDanger}`} title="Eliminar (próximamente)" disabled>×</button>
                        </div>
                      );
                    })}
                    {g.id === "compras" && itemsCompras.map(c => (
                      <div key={c.nombre} className={styles.item}>
                        <span className={styles.itemNombre}>{highlight(sentenceCase(c.nombre), search)}</span>
                        <span />
                        <button className={styles.itemAccion} title="Editar (próximamente)" disabled>✏</button>
                        <button className={`${styles.itemAccion} ${styles.itemAccionDanger}`} title="Eliminar (próximamente)" disabled>×</button>
                      </div>
                    ))}
                    {g.id === "ingresos" && itemsIngresos.map(c => (
                      <div key={c.nombre} className={styles.item}>
                        <span className={styles.itemNombre}>{highlight(sentenceCase(c.nombre), search)}</span>
                        <span />
                        <button className={styles.itemAccion} title="Editar (próximamente)" disabled>✏</button>
                        <button className={`${styles.itemAccion} ${styles.itemAccionDanger}`} title="Eliminar (próximamente)" disabled>×</button>
                      </div>
                    ))}
                    {g.id === "medios" && itemsMedios.map(m => (
                      <div key={m.id} className={styles.item}>
                        <span className={styles.itemNombre}>{highlight(sentenceCase(m.nombre), search)}</span>
                        <span />
                        <button className={styles.itemAccion} title="Editar (próximamente)" disabled>✏</button>
                        <button className={`${styles.itemAccion} ${styles.itemAccionDanger}`} title="Eliminar (próximamente)" disabled>×</button>
                      </div>
                    ))}
                    {g.id === "puestos" && itemsPuestos.map(p => (
                      <div key={p.id} className={styles.item}>
                        <span className={styles.itemNombre}>{highlight(sentenceCase(p.nombre), search)}</span>
                        <span />
                        <button className={styles.itemAccion} title="Editar (próximamente)" disabled>✏</button>
                        <button className={`${styles.itemAccion} ${styles.itemAccionDanger}`} title="Eliminar (próximamente)" disabled>×</button>
                      </div>
                    ))}
                    {g.id === "turnos" && (
                      <div className={styles.empty}>
                        No configurado aún. Próximamente vas a poder definir turnos (Mediodía / Noche / Custom) y horarios por sucursal.
                      </div>
                    )}

                    {count === 0 && g.id !== "turnos" && !searchActive && (
                      <div className={styles.empty}>No hay items en este grupo todavía.</div>
                    )}

                    {g.id !== "turnos" && count > 0 && !searchActive && (
                      <button
                        type="button"
                        className={styles.linkAgregar}
                        onClick={() => { setNuevoModalGrupo(g.id); setNuevoNombre(""); setNuevoTipoGasto("fijo"); }}
                      >
                        + Agregar a {g.label.toLowerCase()}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* Modal de creación contextual */}
      <Modal
        isOpen={nuevoModalGrupo !== null}
        onClose={() => setNuevoModalGrupo(null)}
        title={nuevoModalGrupo
          ? `Nuevo en ${GRUPOS_DEF.find(g => g.id === nuevoModalGrupo)?.label.toLowerCase()}`
          : "Nuevo"}
        subtitle="Se agregará al catálogo y queda disponible en toda la app."
        maxWidth={460}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setNuevoModalGrupo(null)} disabled={saving}>Cancelar</button>
            <button className="btn btn-acc" onClick={guardarNuevo} disabled={!nuevoNombre.trim() || saving}>
              {saving ? "Creando…" : "Crear"}
            </button>
          </>
        }
      >
        <div className={styles.modalField}>
          <label className={styles.modalLabel}>Nombre</label>
          <input
            className={styles.modalInput}
            autoFocus
            value={nuevoNombre}
            onChange={e => setNuevoNombre(e.target.value)}
            placeholder="Ej. Servicios profesionales"
          />
        </div>
        {nuevoModalGrupo === "gastos" && (
          <div className={styles.modalField}>
            <label className={styles.modalLabel}>Tipo</label>
            <div className={styles.modalRadioGroup}>
              <label className={styles.modalRadio}>
                <input type="radio" name="tipoGasto" checked={nuevoTipoGasto === "fijo"} onChange={() => setNuevoTipoGasto("fijo")} />
                Fijo
              </label>
              <label className={styles.modalRadio}>
                <input type="radio" name="tipoGasto" checked={nuevoTipoGasto === "variable"} onChange={() => setNuevoTipoGasto("variable")} />
                Variable
              </label>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
