import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "../components/ui";
import { getDashboardConfig } from "./service";
import { findWidget, widgetsParaRol } from "./widgets/registry";
import { DEFAULT_WIDGETS_POR_ROL, type RolPase, type WidgetContext } from "./types";
import type { WidgetDefinition } from "./types";

/**
 * DashboardHome — pantalla de inicio personalizada por usuario/rol.
 *
 * Flujo:
 *   1. Carga la config del usuario desde DB (widgets_activos en orden).
 *   2. Si no tiene config → usa DEFAULT_WIDGETS_POR_ROL[rol] como fallback.
 *   3. Renderiza cada widget con su tamaño (sm/md/lg/full) en grid responsive.
 *
 * Modificación de widgets: solo desde Settings → Dashboards (dueño/admin).
 */

interface Props {
  usuario: {
    id: number;
    nombre: string;
    rol: RolPase;
    tenant_id: string | null;
  };
  locales: Array<{ id: number; nombre: string }>;
  localActivo: number | null;
}

const SIZE_TO_COL_CLASS: Record<string, string> = {
  sm: "col-span-1",
  md: "col-span-1 md:col-span-2",
  lg: "col-span-1 md:col-span-2 lg:col-span-3",
  full: "col-span-1 md:col-span-2 lg:col-span-3 xl:col-span-4",
};

export function DashboardHome({ usuario, locales, localActivo }: Props) {
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
        // Fallback al default por rol
        setWidgetIds(DEFAULT_WIDGETS_POR_ROL[usuario.rol] ?? []);
      }
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [usuario.id, usuario.rol]);

  const widgets: WidgetDefinition[] = useMemo(() => {
    if (!widgetIds) return [];
    return widgetIds
      .map(findWidget)
      .filter((w): w is WidgetDefinition => Boolean(w) && w!.rolesPermitidos.includes(usuario.rol));
  }, [widgetIds, usuario.rol]);

  const ctx: WidgetContext = useMemo(() => ({
    usuario, locales, localActivo,
  }), [usuario, locales, localActivo]);

  if (loading) {
    return (
      <div className="container py-6">
        <PageHeader title={`Hola, ${usuario.nombre}`} />
        <div className="py-12 text-center text-pase-text-muted text-sm">Cargando dashboard…</div>
      </div>
    );
  }

  const availableCount = widgetsParaRol(usuario.rol).length;

  return (
    <div className="container py-6">
      <PageHeader
        title={`Hola, ${usuario.nombre}`}
        subtitle={greetingByHour()}
      />

      {widgets.length === 0 ? (
        <div className="rounded-xl border border-pase-border bg-pase-bg-soft p-8 text-center">
          <p className="text-pase-text-muted" style={{ fontSize: "var(--pase-fs-base)" }}>
            Tu dashboard está vacío.
          </p>
          {availableCount > 0 && (
            <p className="text-pase-text-muted mt-2" style={{ fontSize: "var(--pase-fs-sm)" }}>
              Hay {availableCount} widget(s) disponibles para tu rol.
              {" "}El dueño puede activarlos desde Settings → Dashboards.
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {widgets.map((w) => (
            <section
              key={w.id}
              className={`${SIZE_TO_COL_CLASS[w.size] ?? SIZE_TO_COL_CLASS.md} rounded-xl border border-pase-border bg-pase-bg p-4 min-w-0`}
              aria-label={w.title}
            >
              <header className="mb-3">
                <h3
                  className="font-medium text-pase-text"
                  style={{
                    fontSize: "var(--pase-fs-base)",
                    letterSpacing: "var(--pase-ls-snug)",
                  }}
                >
                  {w.title}
                </h3>
              </header>
              <div>{w.render(ctx)}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function greetingByHour(): string {
  const h = new Date().getHours();
  if (h < 12) return "buenos días";
  if (h < 19) return "buenas tardes";
  return "buenas noches";
}
