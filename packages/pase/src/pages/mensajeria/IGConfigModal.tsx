// Modal de configuración del bot de Instagram.
//
// Permite al dueño/admin editar:
//   - Toggle "bot_activo" (encender/apagar el bot sin perder config)
//   - Modelo de Claude (Sonnet 4.6 default, opciones para Opus si necesita más smart)
//   - max_tokens por respuesta (longitud máxima del bot)
//   - contexto_mensajes (cuántos mensajes históricos manda al LLM)
//   - system_prompt (la "personalidad" + info + reglas — donde vive todo el conocimiento)
//
// El system_prompt es lo más importante. Es texto libre — Lucas le carga
// lo que quiera (tono, locales, menú, horarios, links, reglas de derivación).
// Mientras más detalle, mejor responde el bot.

import { useState, useEffect } from "react";
import { db } from "../../lib/supabase";
import { Modal } from "../../components/ui";

interface IGConfig {
  tenant_id: string;
  ig_account_id: string;
  ig_username: string | null;
  bot_activo: boolean;
  system_prompt: string | null;
  modelo: string;
  max_tokens: number;
  contexto_mensajes: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const MODELOS_DISPONIBLES = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", precio: "$3 / $15 por M tokens", desc: "Balance precio/calidad. Recomendado." },
  { id: "claude-opus-4-7",   label: "Opus 4.7",   precio: "$15 / $75 por M tokens", desc: "Más smart, 5x más caro. Para razonamiento complejo." },
];

const PROMPT_PLACEHOLDER = `Acá va la "personalidad" del bot + toda la información del negocio.

Ejemplo de estructura:

----------
Sos el asistente oficial de [tu negocio].
Tono: [profesional / casual / amigable].
Máximo X líneas por respuesta.
No inventar información.

INFORMACIÓN POR SUCURSAL
[Sucursal A]
Dirección, horarios, servicios, links de menú/reserva/WhatsApp.

[Sucursal B]
...

REGLAS CRÍTICAS
- Si preguntan X, hacer Y.
- Si reclaman, derivar a WhatsApp.
- Etc.
----------

Mientras más detallado, mejor responde el bot.`;

export function IGConfigModal({ isOpen, onClose }: Props) {
  const [config, setConfig] = useState<IGConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"prompt" | "ajustes">("prompt");

  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      setLoading(true);
      const { data } = await db.from("ig_config")
        .select("*")
        .limit(1)
        .single();
      setConfig(data as IGConfig);
      setLoading(false);
    })();
  }, [isOpen]);

  const guardar = async () => {
    if (!config) return;
    setSaving(true);
    const { error } = await db.from("ig_config")
      .update({
        bot_activo: config.bot_activo,
        modelo: config.modelo,
        max_tokens: config.max_tokens,
        contexto_mensajes: config.contexto_mensajes,
        system_prompt: config.system_prompt,
      })
      .eq("ig_account_id", config.ig_account_id);
    setSaving(false);
    if (error) {
      alert("Error al guardar: " + error.message);
      return;
    }
    onClose();
  };

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="⚙ Configurar bot de Instagram"
      subtitle="Personalidad, conocimiento del negocio y parámetros técnicos."
      maxWidth={900}
      footer={
        <>
          <button className="btn btn-sec" onClick={onClose} disabled={saving}>Cancelar</button>
          <button className="btn btn-acc" onClick={guardar} disabled={saving || !config}>
            {saving ? "Guardando..." : "Guardar cambios"}
          </button>
        </>
      }
    >
      {loading || !config ? (
        <div className="loading">Cargando configuración...</div>
      ) : (
        <div>
          {/* ─── Header con info de la cuenta ─── */}
          <div style={{
            padding: 12, background: "var(--s2)", borderRadius: 8, marginBottom: 16,
            display: "flex", justifyContent: "space-between", alignItems: "center"
          }}>
            <div>
              <div style={{ fontSize: 12, color: "var(--muted2)" }}>Cuenta de Instagram</div>
              <div style={{ fontWeight: 500 }}>@{config.ig_username || config.ig_account_id}</div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <span style={{ fontSize: 12 }}>
                {config.bot_activo ? "🟢 Bot encendido" : "🔴 Bot apagado"}
              </span>
              <input
                type="checkbox"
                checked={config.bot_activo}
                onChange={e => setConfig({ ...config, bot_activo: e.target.checked })}
                style={{ width: 20, height: 20, cursor: "pointer" }}
              />
            </label>
          </div>

          {/* ─── Tabs ─── */}
          <div className="tabs" style={{ marginBottom: 16 }}>
            <div className={`tab ${tab === "prompt" ? "active" : ""}`} onClick={() => setTab("prompt")}>
              📝 Personalidad e info
            </div>
            <div className={`tab ${tab === "ajustes" ? "active" : ""}`} onClick={() => setTab("ajustes")}>
              ⚙ Ajustes técnicos
            </div>
          </div>

          {/* ─── Tab: System Prompt ─── */}
          {tab === "prompt" && (
            <div>
              <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 8, lineHeight: 1.6 }}>
                Acá va la <strong>"personalidad" del bot</strong> y todo lo que tiene que saber para responder
                (locales, horarios, links de menú, reglas de derivación, experiencias especiales, etc).
                Cuanto más detalle, mejor responde. El bot lee este texto en cada mensaje.
              </div>
              <textarea
                value={config.system_prompt || ""}
                onChange={e => setConfig({ ...config, system_prompt: e.target.value })}
                placeholder={PROMPT_PLACEHOLDER}
                style={{
                  width: "100%",
                  minHeight: 400,
                  padding: 12,
                  fontSize: 13,
                  fontFamily: "ui-monospace, 'Courier New', monospace",
                  background: "var(--s2)",
                  border: "1px solid var(--bd)",
                  borderRadius: 6,
                  resize: "vertical",
                  color: "var(--text)",
                  lineHeight: 1.5,
                }}
              />
              <div style={{
                fontSize: 11, color: "var(--muted)", marginTop: 6,
                display: "flex", justifyContent: "space-between",
              }}>
                <span>{(config.system_prompt || "").length} caracteres · ~{Math.ceil((config.system_prompt || "").length / 4)} tokens</span>
                <span>💡 Tip: agregá un menú detallado para que el bot pueda responder precios sin tools.</span>
              </div>
            </div>
          )}

          {/* ─── Tab: Ajustes técnicos ─── */}
          {tab === "ajustes" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label style={{ display: "block", marginBottom: 6, fontSize: 13, fontWeight: 500 }}>
                  Modelo de IA
                </label>
                <select
                  value={config.modelo}
                  onChange={e => setConfig({ ...config, modelo: e.target.value })}
                  style={{ width: "100%", padding: 10, background: "var(--s2)", border: "1px solid var(--bd)", borderRadius: 6, fontSize: 13, color: "var(--text)" }}
                >
                  {MODELOS_DISPONIBLES.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.precio}
                    </option>
                  ))}
                </select>
                <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 4 }}>
                  {MODELOS_DISPONIBLES.find(m => m.id === config.modelo)?.desc}
                </div>
              </div>

              <div>
                <label style={{ display: "block", marginBottom: 6, fontSize: 13, fontWeight: 500 }}>
                  Largo máximo de respuesta: <strong>{config.max_tokens} tokens</strong> (~{Math.round(config.max_tokens * 0.75)} palabras)
                </label>
                <input
                  type="range"
                  min={256}
                  max={2048}
                  step={128}
                  value={config.max_tokens}
                  onChange={e => setConfig({ ...config, max_tokens: Number(e.target.value) })}
                  style={{ width: "100%" }}
                />
                <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 4 }}>
                  Cuánto puede escribir el bot por mensaje. 1024 ≈ 4-5 párrafos cortos. Para DMs cortos, 512 alcanza.
                </div>
              </div>

              <div>
                <label style={{ display: "block", marginBottom: 6, fontSize: 13, fontWeight: 500 }}>
                  Memoria de la conversación: <strong>{config.contexto_mensajes} mensajes</strong>
                </label>
                <input
                  type="range"
                  min={5}
                  max={50}
                  step={5}
                  value={config.contexto_mensajes}
                  onChange={e => setConfig({ ...config, contexto_mensajes: Number(e.target.value) })}
                  style={{ width: "100%" }}
                />
                <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 4 }}>
                  Cuántos mensajes históricos lee el bot para entender el contexto.
                  Más = mejor memoria pero más costo. 30 está bien para la mayoría de casos.
                </div>
              </div>

              <div style={{
                padding: 10, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)",
                borderRadius: 6, fontSize: 11, color: "var(--text)",
              }}>
                ℹ️ Estos cambios se aplican <strong>al próximo mensaje</strong> que reciba el bot.
                No afectan las respuestas que ya están en cola.
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
