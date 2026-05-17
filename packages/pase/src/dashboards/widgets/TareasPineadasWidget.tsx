import { useEffect, useState } from "react";
import { getPinnedNotesPara, completarTarea, type PinnedNote } from "../service";
import { EmptyState } from "../../components/ui";
import type { WidgetContext } from "../types";

const PRIORIDAD_BG: Record<PinnedNote["prioridad"], string> = {
  info: "var(--pase-bg-soft)",
  normal: "var(--pase-celeste-100)",
  alta: "#FEF3C7",
  urgente: "#FEE2E2",
};

const PRIORIDAD_LABEL: Record<PinnedNote["prioridad"], string> = {
  info: "INFO",
  normal: "",
  alta: "ALTA",
  urgente: "URGENTE",
};

// Widget de tareas/mensajes pineados por el dueño para este usuario o su rol.
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
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  if (notas.length === 0) {
    return (
      <EmptyState
        icon="📌"
        title="Sin tareas pineadas"
        description="El dueño puede agregar mensajes para vos desde Ajustes → Dashboards."
        size="compact"
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {notas.map(n => (
        <div
          key={n.id}
          style={{
            background: PRIORIDAD_BG[n.prioridad],
            border: "0.5px solid var(--pase-border)",
            borderRadius: 8,
            padding: 12,
            fontSize: "var(--pase-fs-base)",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            {n.es_tarea && (
              <button
                type="button"
                onClick={() => handleComplete(n.id)}
                aria-label="Marcar como completada"
                title="Marcar como completada"
                style={{
                  marginTop: 2,
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  border: "2px solid var(--pase-celeste)",
                  background: "transparent",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2, flexWrap: "wrap" }}>
                <strong style={{ fontSize: "var(--pase-fs-base)" }}>{n.titulo}</strong>
                {PRIORIDAD_LABEL[n.prioridad] && (
                  <span style={{
                    fontSize: "var(--pase-fs-xs)",
                    color: "var(--pase-text-muted)",
                    fontWeight: 500,
                    letterSpacing: "var(--pase-ls-overline)",
                  }}>
                    {PRIORIDAD_LABEL[n.prioridad]}
                  </span>
                )}
              </div>
              {n.cuerpo && (
                <p style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", lineHeight: 1.5, margin: 0 }}>
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
