import { useEffect, useState } from "react";
import {
  getPinnedNotesPara,
  completarTarea,
  crearNotaPineada,
  eliminarNota,
  listarUsuariosTenant,
  type PinnedNote,
} from "../service";
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

const ROLES_TARGET: Array<{ value: string; label: string }> = [
  { value: "encargado", label: "Todos los encargados" },
  { value: "cajero", label: "Todos los cajeros" },
  { value: "compras", label: "Todos los de compras" },
  { value: "admin", label: "Todos los admin" },
];

// Widget de tareas/mensajes pineados por el dueño para este usuario o su rol.
// Si el usuario es dueño/admin/superadmin, ve además un botón "+ Nuevo mensaje"
// que abre un mini-form inline para crear notas dirigidas a un usuario o rol.
export function TareasPineadasWidget({ ctx }: { ctx: WidgetContext }) {
  const [notas, setNotas] = useState<PinnedNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [creando, setCreando] = useState(false);
  const [usuariosTenant, setUsuariosTenant] = useState<Array<{ id: number; nombre: string }>>([]);

  const puedeCrear = ctx.usuario.rol === "dueno" || ctx.usuario.rol === "admin" || ctx.usuario.rol === "superadmin";

  async function reload() {
    setLoading(true);
    const r = await getPinnedNotesPara(ctx.usuario.id, ctx.usuario.rol);
    if (!r.error) setNotas(r.data.filter(n => !n.completada_at));
    setLoading(false);
  }

  useEffect(() => { void reload(); }, [ctx.usuario.id, ctx.usuario.rol]);

  useEffect(() => {
    if (!puedeCrear) return;
    let cancelled = false;
    async function loadUsers() {
      const r = await listarUsuariosTenant();
      if (!cancelled && !r.error) setUsuariosTenant(r.data);
    }
    void loadUsers();
    return () => { cancelled = true; };
  }, [puedeCrear]);

  async function handleComplete(notaId: number) {
    const r = await completarTarea(notaId, ctx.usuario.id);
    if (!r.error) setNotas(prev => prev.filter(n => n.id !== notaId));
  }

  async function handleDelete(notaId: number) {
    if (!confirm("¿Eliminar este mensaje?")) return;
    const r = await eliminarNota(notaId);
    if (!r.error) setNotas(prev => prev.filter(n => n.id !== notaId));
  }

  if (loading) {
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  return (
    <div>
      {notas.length === 0 ? (
        <EmptyState
          icon="📌"
          title="Sin tareas ni mensajes"
          description={puedeCrear ? "Usá el botón de abajo para dejarle un mensaje a alguien." : "Cuando el dueño te deje un mensaje, lo vas a ver acá."}
          size="compact"
        />
      ) : (
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
                {puedeCrear && (
                  <button
                    type="button"
                    onClick={() => handleDelete(n.id)}
                    title="Eliminar"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--pase-text-muted)",
                      cursor: "pointer",
                      fontSize: 14,
                      padding: 0,
                      lineHeight: 1,
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {puedeCrear && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: notas.length > 0 ? "0.5px solid var(--pase-border)" : "none" }}>
          {creando ? (
            <CrearNotaForm
              tenantId={ctx.usuario.tenant_id ?? ""}
              creadorId={ctx.usuario.id}
              usuarios={usuariosTenant}
              localActivo={ctx.localActivo}
              onCancel={() => setCreando(false)}
              onCreated={() => { setCreando(false); void reload(); }}
            />
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setCreando(true)}
              style={{ width: "100%", justifyContent: "center" }}
            >
              + Nuevo mensaje
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface CrearNotaFormProps {
  tenantId: string;
  creadorId: number;
  usuarios: Array<{ id: number; nombre: string }>;
  localActivo: number | null;
  onCancel: () => void;
  onCreated: () => void;
}

function CrearNotaForm({ tenantId, creadorId, usuarios, localActivo, onCancel, onCreated }: CrearNotaFormProps) {
  // Target: "u:<id>" para usuario específico, "r:<rol>" para rol.
  const [target, setTarget] = useState<string>("r:encargado");
  const [prioridad, setPrioridad] = useState<PinnedNote["prioridad"]>("normal");
  const [titulo, setTitulo] = useState("");
  const [cuerpo, setCuerpo] = useState("");
  const [esTarea, setEsTarea] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!titulo.trim()) return;
    setSaving(true);
    setError(null);
    const isUser = target.startsWith("u:");
    const r = await crearNotaPineada(
      {
        tenantId,
        localId: localActivo,
        targetUsuarioId: isUser ? Number(target.slice(2)) : null,
        targetRol: isUser ? null : target.slice(2),
        prioridad,
        titulo: titulo.trim(),
        cuerpo: cuerpo.trim() || null,
        esTarea,
      },
      creadorId,
    );
    setSaving(false);
    if (r.error) {
      setError(r.error);
      return;
    }
    onCreated();
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <select
        value={target}
        onChange={e => setTarget(e.target.value)}
        className="search"
        style={{ width: "100%" }}
      >
        <optgroup label="Por rol">
          {ROLES_TARGET.map(r => (
            <option key={`r:${r.value}`} value={`r:${r.value}`}>{r.label}</option>
          ))}
        </optgroup>
        {usuarios.length > 0 && (
          <optgroup label="Usuario específico">
            {usuarios.map(u => (
              <option key={`u:${u.id}`} value={`u:${u.id}`}>{u.nombre}</option>
            ))}
          </optgroup>
        )}
      </select>

      <input
        type="text"
        value={titulo}
        onChange={e => setTitulo(e.target.value)}
        placeholder="Título"
        maxLength={120}
        className="search"
        style={{ width: "100%" }}
        autoFocus
      />

      <textarea
        value={cuerpo}
        onChange={e => setCuerpo(e.target.value)}
        placeholder="Mensaje (opcional)"
        rows={2}
        style={{
          width: "100%",
          padding: "8px 12px",
          border: "0.5px solid var(--pase-border-strong)",
          borderRadius: 8,
          background: "var(--pase-bg)",
          color: "var(--pase-text)",
          fontFamily: "var(--pase-font)",
          fontSize: "var(--pase-fs-base)",
          resize: "vertical",
          outline: "none",
        }}
      />

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={prioridad}
          onChange={e => setPrioridad(e.target.value as PinnedNote["prioridad"])}
          className="search"
          style={{ flex: 1, minWidth: 120 }}
        >
          <option value="info">Info</option>
          <option value="normal">Normal</option>
          <option value="alta">Alta</option>
          <option value="urgente">Urgente</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>
          <input
            type="checkbox"
            checked={esTarea}
            onChange={e => setEsTarea(e.target.checked)}
            style={{ accentColor: "var(--pase-celeste)" }}
          />
          Es tarea
        </label>
      </div>

      {error && (
        <div style={{ fontSize: "var(--pase-fs-xs)", color: "#B91C1C" }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={saving}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-acc btn-sm" disabled={saving || !titulo.trim()}>
          {saving ? "Enviando…" : "Enviar"}
        </button>
      </div>
    </form>
  );
}
