// Modal para editar la memoria que el bot tiene de un cliente puntual.
//
// El bot lee estos campos al armar el system prompt en cada conversación,
// como "CONTEXTO DEL CLIENTE" (ver webhook.js construirSystemPromptConContexto).
//
// Permite que vos como dueño/admin enriquezcas la memoria sin que el cliente
// haya tenido que decirlo: ej. cargar el nombre del cliente que ya conocés.

import { useState, useEffect } from "react";
import { db } from "../../lib/supabase";
import { Modal } from "../../components/ui";
import { useToast } from "../../hooks/useToast";
import { ToastComponent } from "../../components/Toast";

interface IGCliente {
  id: number;
  igsid: string;
  nombre: string | null;
  telefono: string | null;
  email: string | null;
  alergias: string | null;
  preferencias: string | null;
  notas_internas: string | null;
  bloqueado: boolean;
  bloqueado_motivo: string | null;
  mensajes_count: number;
  primera_interaccion: string;
}

interface Props {
  clienteId: number | null;
  onClose: () => void;
  onSaved: () => void;
}

export function IGClienteModal({ clienteId, onClose, onSaved }: Props) {
  const [cliente, setCliente] = useState<IGCliente | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast, showError } = useToast();

  useEffect(() => {
    if (!clienteId) return;
    (async () => {
      setLoading(true);
      const { data } = await db.from("ig_clientes")
        .select("*")
        .eq("id", clienteId)
        .single();
      setCliente(data as IGCliente);
      setLoading(false);
    })();
  }, [clienteId]);

  const guardar = async () => {
    if (!cliente) return;
    setSaving(true);
    const { error } = await db.from("ig_clientes")
      .update({
        nombre: cliente.nombre?.trim() || null,
        telefono: cliente.telefono?.trim() || null,
        email: cliente.email?.trim() || null,
        alergias: cliente.alergias?.trim() || null,
        preferencias: cliente.preferencias?.trim() || null,
        notas_internas: cliente.notas_internas?.trim() || null,
      })
      .eq("id", cliente.id);
    setSaving(false);
    if (error) {
      showError("Error al guardar: " + error.message);
      return;
    }
    onSaved();
    onClose();
  };

  return (
    <>
    {toast && <ToastComponent toast={toast} />}
    <Modal
      isOpen={clienteId !== null}
      onClose={onClose}
      title="🧠 Memoria del cliente"
      subtitle="El bot lee esto en cada respuesta para personalizar el trato."
      maxWidth={600}
      footer={
        <>
          <button className="btn btn-sec" onClick={onClose} disabled={saving}>Cancelar</button>
          <button className="btn btn-acc" onClick={guardar} disabled={saving || !cliente}>
            {saving ? "Guardando..." : "Guardar"}
          </button>
        </>
      }
    >
      {loading || !cliente ? (
        <div className="loading">Cargando...</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 11, color: "var(--muted2)" }}>
            Instagram ID: <code>{cliente.igsid}</code> · {cliente.mensajes_count} mensajes ·
            Primera vez: {new Date(cliente.primera_interaccion).toLocaleDateString("es-AR")}
          </div>

          <div className="field">
            <label>Nombre</label>
            <input
              value={cliente.nombre || ""}
              onChange={e => setCliente({ ...cliente, nombre: e.target.value })}
              placeholder="Ej: Juan Pérez"
            />
          </div>

          <div className="form2">
            <div className="field">
              <label>Teléfono</label>
              <input
                value={cliente.telefono || ""}
                onChange={e => setCliente({ ...cliente, telefono: e.target.value })}
                placeholder="Ej: +54 9 11 1234-5678"
              />
            </div>
            <div className="field">
              <label>Email</label>
              <input
                type="email"
                value={cliente.email || ""}
                onChange={e => setCliente({ ...cliente, email: e.target.value })}
                placeholder="cliente@ejemplo.com"
              />
            </div>
          </div>

          <div className="field">
            <label>🥦 Alergias / Restricciones alimentarias</label>
            <textarea
              value={cliente.alergias || ""}
              onChange={e => setCliente({ ...cliente, alergias: e.target.value })}
              placeholder="Ej: Celíaco confirmado, no come pescado crudo"
              rows={2}
              style={{ resize: "vertical" }}
            />
            <div style={{ fontSize: 10, color: "var(--muted2)" }}>
              El bot va a evitar recomendarle cosas con estos ingredientes.
            </div>
          </div>

          <div className="field">
            <label>❤️ Preferencias / Gustos</label>
            <textarea
              value={cliente.preferencias || ""}
              onChange={e => setCliente({ ...cliente, preferencias: e.target.value })}
              placeholder="Ej: Le gusta lo picante, siempre pide rolls deluxe, prefiere salón a delivery"
              rows={2}
              style={{ resize: "vertical" }}
            />
            <div style={{ fontSize: 10, color: "var(--muted2)" }}>
              Info que el bot usa para personalizar recomendaciones.
            </div>
          </div>

          <div className="field">
            <label>🗒️ Notas internas (privadas)</label>
            <textarea
              value={cliente.notas_internas || ""}
              onChange={e => setCliente({ ...cliente, notas_internas: e.target.value })}
              placeholder="Ej: VIP — su esposa cumple en mayo, siempre pide la mesa 7"
              rows={2}
              style={{ resize: "vertical" }}
            />
            <div style={{ fontSize: 10, color: "var(--warn)" }}>
              ⚠ Estas notas también las ve el bot. Si querés que algo NO lo vea, no lo escribas acá.
            </div>
          </div>

          {cliente.bloqueado && (
            <div style={{
              padding: 10, background: "rgba(220,38,38,0.08)", border: "0.5px solid rgba(220,38,38,0.25)",
              borderRadius: 6, fontSize: 12,
            }}>
              🚫 <strong>Cliente bloqueado.</strong> {cliente.bloqueado_motivo && `Motivo: ${cliente.bloqueado_motivo}.`}
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginLeft: 8 }}
                onClick={async () => {
                  await db.from("ig_clientes").update({ bloqueado: false, bloqueado_motivo: null }).eq("id", cliente.id);
                  setCliente({ ...cliente, bloqueado: false, bloqueado_motivo: null });
                  onSaved();
                }}
              >
                Desbloquear
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
    </>
  );
}
