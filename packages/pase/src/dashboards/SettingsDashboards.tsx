import { useEffect, useState } from "react";
import { db } from "../lib/supabase";
import { PageHeader } from "../components/ui";
import { getDashboardConfig, saveDashboardConfig } from "./service";
import { WIDGETS, widgetsParaRol } from "./widgets/registry";
import { DEFAULT_WIDGETS_POR_ROL, type RolPase } from "./types";

interface UsuarioLite {
  id: number;
  nombre: string;
  rol: RolPase;
}

/**
 * Settings → Dashboards
 *
 * UI para que el dueño/admin configure qué widgets ve cada usuario en su
 * dashboard personal. Solo lista los widgets que aplican al rol del usuario.
 *
 * Para Sesión 1 hago checkboxes simples (activar/desactivar). El orden es
 * el del array `widgets_activos` — por ahora se ordena por orden de
 * activación. Drag-drop visual queda para Sesión 2.
 */
export default function SettingsDashboards({ tenantId }: { tenantId: string }) {
  const [usuarios, setUsuarios] = useState<UsuarioLite[]>([]);
  const [usuarioSel, setUsuarioSel] = useState<UsuarioLite | null>(null);
  const [widgetsActivos, setWidgetsActivos] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const { data, error } = await db
        .from("usuarios")
        .select("id, nombre, rol, activo")
        .eq("activo", true)
        .order("nombre");
      if (cancelled || error) { setLoading(false); return; }
      const list = (data ?? []) as UsuarioLite[];
      setUsuarios(list);
      if (list.length > 0 && !usuarioSel) setUsuarioSel(list[0]!);
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!usuarioSel) return;
    let cancelled = false;
    async function loadConfig() {
      const r = await getDashboardConfig(usuarioSel!.id);
      if (cancelled) return;
      if (r.data && !r.data.es_default) {
        setWidgetsActivos(r.data.widgets_activos);
      } else {
        setWidgetsActivos(DEFAULT_WIDGETS_POR_ROL[usuarioSel!.rol] ?? []);
      }
    }
    void loadConfig();
    return () => { cancelled = true; };
  }, [usuarioSel]);

  async function toggleWidget(widgetId: string) {
    if (!usuarioSel) return;
    const isActive = widgetsActivos.includes(widgetId);
    const next = isActive
      ? widgetsActivos.filter(id => id !== widgetId)
      : [...widgetsActivos, widgetId];
    setWidgetsActivos(next);
    // Persistir inmediato (no esperar botón "Guardar")
    setSaving(true);
    await saveDashboardConfig(usuarioSel.id, tenantId, {
      widgets_activos: next,
      widgets_config: {},
      es_default: false,
    });
    setSaving(false);
  }

  async function resetearDefault() {
    if (!usuarioSel) return;
    const defaults = DEFAULT_WIDGETS_POR_ROL[usuarioSel.rol] ?? [];
    setWidgetsActivos(defaults);
    setSaving(true);
    await saveDashboardConfig(usuarioSel.id, tenantId, {
      widgets_activos: defaults,
      widgets_config: {},
      es_default: true,
    });
    setSaving(false);
  }

  if (loading) {
    return <div className="container py-6">Cargando…</div>;
  }

  const widgetsDisponibles = usuarioSel ? widgetsParaRol(usuarioSel.rol) : [];
  const widgetsNoAplican = WIDGETS.length - widgetsDisponibles.length;

  return (
    <div className="container py-6">
      <PageHeader
        title="Dashboards"
        subtitle="personalizar por usuario"
      />

      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-6">
        {/* Lista de usuarios */}
        <aside className="space-y-1">
          <div
            className="uppercase font-medium text-pase-text-muted mb-2 px-2"
            style={{ fontSize: "var(--pase-fs-sm)", letterSpacing: "var(--pase-ls-overline)" }}
          >
            Usuarios
          </div>
          {usuarios.map(u => (
            <button
              key={u.id}
              type="button"
              onClick={() => setUsuarioSel(u)}
              className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                usuarioSel?.id === u.id
                  ? "bg-pase-celeste text-white"
                  : "hover:bg-pase-bg-soft text-pase-text"
              }`}
              style={{ fontSize: "var(--pase-fs-base)" }}
            >
              <div className="font-medium">{u.nombre}</div>
              <div
                className={usuarioSel?.id === u.id ? "text-white/80" : "text-pase-text-muted"}
                style={{ fontSize: "var(--pase-fs-xs)" }}
              >
                {u.rol}
              </div>
            </button>
          ))}
        </aside>

        {/* Config del usuario seleccionado */}
        <main>
          {!usuarioSel ? (
            <div className="text-center py-12 text-pase-text-muted">
              Seleccioná un usuario.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <div>
                  <h2 className="font-medium" style={{ fontSize: "var(--pase-fs-lg)" }}>
                    Widgets de {usuarioSel.nombre}
                  </h2>
                  <p
                    className="text-pase-text-muted mt-0.5"
                    style={{ fontSize: "var(--pase-fs-sm)" }}
                  >
                    Marcá los widgets que querés que vea en su dashboard.
                    {saving && " · guardando…"}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={resetearDefault}
                  disabled={saving}
                >
                  Resetear al default del rol
                </button>
              </div>

              <div className="space-y-2">
                {widgetsDisponibles.map(w => {
                  const active = widgetsActivos.includes(w.id);
                  return (
                    <label
                      key={w.id}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                        active
                          ? "border-pase-celeste bg-pase-celeste-100"
                          : "border-pase-border hover:bg-pase-bg-soft"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() => toggleWidget(w.id)}
                        className="mt-0.5 w-4 h-4 accent-pase-celeste flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div
                          className="font-medium text-pase-text"
                          style={{ fontSize: "var(--pase-fs-base)" }}
                        >
                          {w.title}
                        </div>
                        <div
                          className="text-pase-text-muted mt-0.5"
                          style={{ fontSize: "var(--pase-fs-sm)" }}
                        >
                          {w.description}
                        </div>
                      </div>
                      <span
                        className="text-pase-text-muted uppercase font-medium flex-shrink-0"
                        style={{
                          fontSize: "var(--pase-fs-xs)",
                          letterSpacing: "var(--pase-ls-overline)",
                        }}
                      >
                        {w.size}
                      </span>
                    </label>
                  );
                })}
              </div>

              {widgetsNoAplican > 0 && (
                <p
                  className="text-pase-text-muted italic mt-4"
                  style={{ fontSize: "var(--pase-fs-sm)" }}
                >
                  {widgetsNoAplican} widget(s) extra existen pero no aplican al rol{" "}
                  <strong>{usuarioSel.rol}</strong>.
                </p>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
