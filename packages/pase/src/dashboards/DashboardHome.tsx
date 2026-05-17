import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHeader } from "../components/ui";
import { getDashboardConfig } from "./service";
import { findWidget, widgetsParaPermisos } from "./widgets/registry";
import { DEFAULT_WIDGETS_POR_ROL, type RolPase, type WidgetContext } from "./types";
import type { WidgetDefinition } from "./types";
import { lanzarTour } from "../lib/onboardingTours";

/**
 * DashboardHome — pantalla de inicio personalizada por usuario.
 *
 * Flujo:
 *   1. Carga la config del usuario desde DB (widgets_activos en orden).
 *   2. Si no tiene config → usa DEFAULT_WIDGETS_POR_ROL[rol] como fallback inicial.
 *   3. Filtra los widgets por **permisos efectivos** del usuario (no por rol).
 *   4. Renderiza cada widget con su tamaño (sm/md/lg/full).
 *
 * Solo dueño/admin/superadmin ven el botón "Configurar dashboards" → Settings.
 *
 * Por qué permisos y no rol (decisión 2026-05-17): la matriz de permisos
 * reemplazó la diferenciación por rol nominal. Casi todos los usuarios tienen
 * rol "encargado" en la tabla, pero pueden tener permisos muy distintos
 * (algunos solo caja, otros compras+caja, etc.). Filtrar por rol dejaba a
 * la mayoría sin widgets disponibles.
 */

interface Props {
  usuario: {
    id: number;
    nombre: string;
    rol: RolPase;
    tenant_id: string | null;
  };
  permisos: string[];
  locales: Array<{ id: number; nombre: string }>;
  localActivo: number | null;
}

// Map tamaño widget → ancho en grid de 12 columnas (estilo Bootstrap).
// sm = 4/12 (3 por fila), md = 6/12 (2 por fila), lg = 8/12, full = 12/12.
const SIZE_TO_SPAN: Record<string, number> = {
  sm: 4,
  md: 6,
  lg: 8,
  full: 12,
};

export function DashboardHome({ usuario, permisos, locales, localActivo }: Props) {
  const navigate = useNavigate();
  const [widgetIds, setWidgetIds] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const r = await getDashboardConfig(usuario.id);
      if (cancelled) return;
      if (r.data && r.data.widgets_activos.length > 0 && !r.data.es_default) {
        setWidgetIds(r.data.widgets_activos);
      } else {
        setWidgetIds(DEFAULT_WIDGETS_POR_ROL[usuario.rol] ?? []);
      }
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [usuario.id, usuario.rol]);

  // Tour de bienvenida — se dispara automático la primera vez que un usuario
  // entra. Refactor 2026-05-17: los tours son por PERMISO (no por rol), así
  // que pasamos `permisos` y el motor decide cuáles mostrar. Si el user ya
  // vio bienvenida y todos sus permisos, no hace nada. Si tiene permisos
  // nuevos desde la última vez, le muestra solo esos.
  useEffect(() => {
    const t = setTimeout(() => {
      lanzarTour(permisos, usuario.id, navigate);
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usuario.id, permisos]);

  const widgets: WidgetDefinition[] = useMemo(() => {
    if (!widgetIds) return [];
    // Filtramos los widgets activos del usuario por permisos efectivos.
    // Si un widget activo ya no aplica (cambió permisos), simplemente no
    // se renderiza — sin romper.
    const visibles = new Set(widgetsParaPermisos(permisos).map(w => w.id));
    return widgetIds
      .map(findWidget)
      .filter((w): w is WidgetDefinition => Boolean(w) && visibles.has(w!.id));
  }, [widgetIds, permisos]);

  const ctx: WidgetContext = useMemo(() => ({
    usuario, locales, localActivo,
  }), [usuario, locales, localActivo]);

  const puedeConfigurar = usuario.rol === "dueno" || usuario.rol === "admin" || usuario.rol === "superadmin";

  if (loading) {
    return (
      <div style={{ padding: "0 20px" }}>
        <PageHeader title={`Hola, ${usuario.nombre}`} />
        <div className="loading">Cargando dashboard…</div>
      </div>
    );
  }

  const availableCount = widgetsParaPermisos(permisos).length;

  return (
    <div style={{ padding: "0 20px" }}>
      <PageHeader
        title={`Hola, ${usuario.nombre}`}
        subtitle={greetingByHour()}
        info={puedeConfigurar
          ? <>Si querés cambiar qué widgets ve cada usuario, andá a <strong>Herramientas → Configurar dashboards</strong>.</>
          : undefined
        }
      />

      {widgets.length === 0 ? (
        <div className="panel" style={{ padding: 32, textAlign: "center" }}>
          <p style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-base)", margin: 0 }}>
            Tu dashboard está vacío.
          </p>
          {availableCount > 0 && puedeConfigurar && (
            <p style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)", marginTop: 8 }}>
              Hay {availableCount} widget(s) disponibles para tus permisos.{" "}
              <Link to="/ajustes/dashboards" style={{ color: "var(--pase-celeste)" }}>
                Configurar →
              </Link>
            </p>
          )}
          {availableCount > 0 && !puedeConfigurar && (
            <p style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)", marginTop: 8 }}>
              Pedile al dueño que active widgets desde Ajustes → Dashboards.
            </p>
          )}
        </div>
      ) : (
        <div className="dashboard-grid">
          {widgets.map((w) => {
            const span = SIZE_TO_SPAN[w.size] ?? 6;
            return (
              <section
                key={w.id}
                style={{
                  gridColumn: `span ${span}`,
                  background: "var(--pase-bg)",
                  border: "0.5px solid var(--pase-border)",
                  borderRadius: "var(--pase-radius-card)",
                  padding: 16,
                  minWidth: 0,
                }}
                aria-label={w.title}
                className="dashboard-widget"
              >
                <header style={{ marginBottom: 12 }}>
                  <h3 style={{
                    margin: 0,
                    fontSize: "var(--pase-fs-base)",
                    fontWeight: 500,
                    color: "var(--pase-text)",
                    letterSpacing: "var(--pase-ls-snug)",
                  }}>
                    {w.title}
                  </h3>
                </header>
                <div>{w.render(ctx)}</div>
              </section>
            );
          })}
        </div>
      )}

      <style>{`
        .dashboard-grid {
          display: grid;
          grid-template-columns: repeat(12, 1fr);
          gap: 16px;
        }
        @media (max-width: 900px) {
          .dashboard-widget {
            grid-column: span 12 !important;
          }
        }
      `}</style>
    </div>
  );
}

function greetingByHour(): string {
  const h = new Date().getHours();
  if (h < 12) return "buenos días";
  if (h < 19) return "buenas tardes";
  return "buenas noches";
}
