import { useEffect, useState } from "react";
import { getPinnedNotesPara, completarTarea, type PinnedNote } from "../service";
import type { WidgetContext } from "../types";

const PRIORIDAD_TONE: Record<PinnedNote["prioridad"], string> = {
  info: "bg-pase-bg-soft border-pase-border",
  normal: "bg-pase-celeste-100 border-pase-celeste-300",
  alta: "bg-amber-50 border-amber-300",
  urgente: "bg-red-50 border-red-300",
};

const PRIORIDAD_LABEL: Record<PinnedNote["prioridad"], string> = {
  info: "INFO",
  normal: "",
  alta: "ALTA",
  urgente: "URGENTE",
};

// Widget de tareas/mensajes pineados por el dueño para este usuario o su rol.
// El usuario puede marcar tareas como completadas (si es_tarea=true).
export function TareasPineadasWidget({ ctx }: { ctx: WidgetContext }) {
  const [notas, setNotas] = useState<PinnedNote[]>([]);
  const [loading, setLoading] = useState(true);

  async function reload() {
    setLoading(true);
    const r = await getPinnedNotesPara(ctx.usuario.id, ctx.usuario.rol);
    if (!r.error) setNotas(r.data.filter(n => !n.completada_at));
    setLoading(false);
  }

  useEffect(() => { void reload(); }, [ctx.usuario.id, ctx.usuario.rol]);

  async function handleComplete(notaId: number) {
    const r = await completarTarea(notaId, ctx.usuario.id);
    if (!r.error) setNotas(prev => prev.filter(n => n.id !== notaId));
  }

  if (loading) {
    return <div className="py-4 text-center text-xs text-pase-text-muted">Cargando…</div>;
  }

  if (notas.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-pase-text-muted italic">
        Sin tareas pineadas. El dueño puede agregar mensajes acá desde Settings → Dashboards.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {notas.map(n => (
        <div
          key={n.id}
          className={`rounded-lg border p-3 ${PRIORIDAD_TONE[n.prioridad]}`}
          style={{ fontSize: "var(--pase-fs-base)" }}
        >
          <div className="flex items-start gap-2">
            {n.es_tarea && (
              <button
                type="button"
                onClick={() => handleComplete(n.id)}
                aria-label="Marcar como completada"
                title="Marcar como completada"
                className="mt-0.5 w-4 h-4 rounded border-2 border-pase-celeste flex items-center justify-center hover:bg-pase-celeste-100 transition-colors flex-shrink-0"
              />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 mb-0.5">
                <strong style={{ fontSize: "var(--pase-fs-base)" }}>{n.titulo}</strong>
                {PRIORIDAD_LABEL[n.prioridad] && (
                  <span
                    className="text-pase-text-muted font-medium"
                    style={{ fontSize: "var(--pase-fs-xs)", letterSpacing: "var(--pase-ls-overline)" }}
                  >
                    {PRIORIDAD_LABEL[n.prioridad]}
                  </span>
                )}
              </div>
              {n.cuerpo && (
                <p style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", lineHeight: 1.5 }}>
                  {n.cuerpo}
                </p>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
