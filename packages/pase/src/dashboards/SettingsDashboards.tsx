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
 * dashboard. Solo lista los widgets que aplican al rol del usuario.
 *
 * Para Sesión 1: checkboxes simples (activar/desactivar). El orden es por
 * orden de activación. Drag-drop visual queda para Sesión 2.
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
    return <div style={{ padding: "0 20px" }}>Cargando…</div>;
  }

  const widgetsDisponibles = usuarioSel ? widgetsParaRol(usuarioSel.rol) : [];
  const widgetsNoAplican = WIDGETS.length - widgetsDisponibles.length;

  return (
    <div style={{ padding: "0 20px" }}>
      <PageHeader title="Dashboards" subtitle="personalizar por usuario" />

      <div className="settings-dash-layout">
        {/* Lista de usuarios */}
        <aside style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{
            textTransform: "uppercase",
            fontWeight: 500,
            color: "var(--pase-text-muted)",
            marginBottom: 8,
            padding: "0 8px",
            fontSize: "var(--pase-fs-sm)",
            letterSpacing: "var(--pase-ls-overline)",
          }}>
            Usuarios
          </div>
          {usuarios.map(u => {
            const active = usuarioSel?.id === u.id;
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => setUsuarioSel(u)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "none",
                  cursor: "pointer",
                  background: active ? "var(--pase-celeste)" : "transparent",
                  color: active ? "#fff" : "var(--pase-text)",
                  fontSize: "var(--pase-fs-base)",
                  fontFamily: "var(--pase-font)",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--pase-bg-soft)"; }}
                onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <div style={{ fontWeight: 500 }}>{u.nombre}</div>
                <div style={{
                  fontSize: "var(--pase-fs-xs)",
                  color: active ? "rgba(255,255,255,0.8)" : "var(--pase-text-muted)",
                }}>
                  {u.rol}
                </div>
              </button>
            );
          })}
        </aside>

        {/* Config del usuario seleccionado */}
        <main>
          {!usuarioSel ? (
            <div style={{ padding: 48, textAlign: "center", color: "var(--pase-text-muted)" }}>
              Seleccioná un usuario.
            </div>
          ) : (
            <>
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 16,
                flexWrap: "wrap",
                gap: 8,
              }}>
                <div>
                  <h2 style={{ margin: 0, fontWeight: 500, fontSize: "var(--pase-fs-lg)" }}>
                    Widgets de {usuarioSel.nombre}
                  </h2>
                  <p style={{
                    color: "var(--pase-text-muted)",
                    margin: "2px 0 0",
                    fontSize: "var(--pase-fs-sm)",
                  }}>
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

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {widgetsDisponibles.map(w => {
                  const active = widgetsActivos.includes(w.id);
                  return (
                    <label
                      key={w.id}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 12,
                        padding: 12,
                        borderRadius: 8,
                        border: `0.5px solid ${active ? "var(--pase-celeste)" : "var(--pase-border)"}`,
                        background: active ? "var(--pase-celeste-100)" : "transparent",
                        cursor: "pointer",
                        transition: "all 0.12s",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() => toggleWidget(w.id)}
                        style={{
                          marginTop: 2,
                          width: 16,
                          height: 16,
                          accentColor: "var(--pase-celeste)",
                          flexShrink: 0,
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, color: "var(--pase-text)", fontSize: "var(--pase-fs-base)" }}>
                          {w.title}
                        </div>
                        <div style={{
                          color: "var(--pase-text-muted)",
                          marginTop: 2,
                          fontSize: "var(--pase-fs-sm)",
                        }}>
                          {w.description}
                        </div>
                      </div>
                      <span style={{
                        color: "var(--pase-text-muted)",
                        textTransform: "uppercase",
                        fontWeight: 500,
                        flexShrink: 0,
                        fontSize: "var(--pase-fs-xs)",
                        letterSpacing: "var(--pase-ls-overline)",
                      }}>
                        {w.size}
                      </span>
                    </label>
                  );
                })}
              </div>

              {widgetsNoAplican > 0 && (
                <p style={{
                  color: "var(--pase-text-muted)",
                  fontStyle: "italic",
                  marginTop: 16,
                  fontSize: "var(--pase-fs-sm)",
                }}>
                  {widgetsNoAplican} widget(s) extra existen pero no aplican al rol{" "}
                  <strong>{usuarioSel.rol}</strong>.
                </p>
              )}
            </>
          )}
        </main>
      </div>

      <style>{`
        .settings-dash-layout {
          display: grid;
          grid-template-columns: 240px 1fr;
          gap: 24px;
        }
        @media (max-width: 700px) {
          .settings-dash-layout {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}
