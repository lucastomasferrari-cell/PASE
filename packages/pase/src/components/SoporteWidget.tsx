// Widget de soporte (botón flotante + panel chat).
//
// El usuario abre el panel desde cualquier pantalla, escribe una duda, le
// llega respuesta del asistente IA. Si la respuesta no resuelve, click en
// "Reportar como bug" persiste el ticket en tickets_soporte para que
// Lucas lo atienda desde el Admin Console.
//
// Endpoint: POST /api/claude con task='soporte-chat'. El server inyecta
// el system prompt operativo (no se carga en bundle del cliente).
//
// Auth: el endpoint requiere Bearer <supabase_jwt>. Tomamos el token de
// la sesión actual via db.auth.getSession().

import { useState, useRef, useEffect } from "react";
import { db } from "../lib/supabase";
import type { Usuario } from "../types";

interface Props {
  user: Usuario;
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export function SoporteWidget({ user }: Props) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [reportando, setReportando] = useState(false);
  const [reporteOk, setReporteOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll al fondo cuando entra un mensaje nuevo.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [msgs, open]);

  async function enviar() {
    const text = input.trim();
    if (!text || loading) return;
    setError(null);
    setReporteOk(false);
    const nuevoMsgs: ChatMsg[] = [...msgs, { role: "user", content: text }];
    setMsgs(nuevoMsgs);
    setInput("");
    setLoading(true);
    try {
      const { data: sess } = await db.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Sesión expirada. Refrescá la página.");

      const resp = await fetch("/api/claude", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          task: "soporte-chat",
          messages: nuevoMsgs.map((m) => ({ role: m.role, content: m.content })),
          contexto: {
            sistema: "pase",
            pantalla: window.location.pathname,
            rol: user?.rol,
            email: user?.email,
          },
        }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        throw new Error(json?.error?.message || json?.error || `HTTP ${resp.status}`);
      }
      const text = json.content?.[0]?.text || json.content?.text || "(Respuesta vacía)";
      setMsgs((prev) => [...prev, { role: "assistant", content: text }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function reportarBug() {
    if (msgs.length === 0 || reportando) return;
    if (!user.tenant_id) {
      // Superadmin no tiene tenant_id propio. Reportar bugs propios desde
      // dentro de PASE no tiene sentido (Lucas ya es el que atiende).
      setError("Estás logueado como superadmin — no hay tenant para asociar el ticket. Si querés reportar algo, usá Admin Console.");
      return;
    }
    setReportando(true);
    setError(null);
    try {
      const ultimaUser = [...msgs].reverse().find((m) => m.role === "user");
      const ultimaAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
      const { error: rpcErr } = await db.from("tickets_soporte").insert({
        tenant_id: user.tenant_id,
        autor_user_id: user.id,
        autor_email: user.email,
        autor_rol: user.rol,
        sistema: "pase",
        pantalla_origen: window.location.pathname,
        mensaje: ultimaUser?.content || "(sin mensaje)",
        categoria: "bug",
        prioridad: "media", // el superadmin reclasifica en el Admin Console
        respuesta_llm: ultimaAssistant?.content || null,
        contexto_jsonb: {
          historial: msgs,
          user_agent: navigator.userAgent,
          url_completa: window.location.href,
        },
      });
      if (rpcErr) throw rpcErr;
      setReporteOk(true);
      setMsgs((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "✓ Reporte enviado a Lucas. Vas a recibir respuesta cuando lo atienda.",
        },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReportando(false);
    }
  }

  function reset() {
    setMsgs([]);
    setInput("");
    setError(null);
    setReporteOk(false);
  }

  return (
    <>
      {/* Botón flotante */}
      <button
        onClick={() => setOpen(!open)}
        className="btn btn-acc"
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          zIndex: 9000,
          width: 52,
          height: 52,
          borderRadius: 26,
          padding: 0,
          fontSize: 22,
          boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
        }}
        title="Ayuda / Soporte"
        aria-label="Abrir soporte"
      >
        💬
      </button>

      {open && (
        <div
          style={{
            position: "fixed",
            bottom: 84,
            right: 20,
            width: 400,
            maxWidth: "calc(100vw - 40px)",
            height: 560,
            maxHeight: "calc(100vh - 110px)",
            background: "var(--bg)",
            border: "1px solid var(--bd)",
            borderRadius: "var(--r)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            display: "flex",
            flexDirection: "column",
            zIndex: 9001,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid var(--bd)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Ayuda PASE</div>
              <div style={{ fontSize: 10, color: "var(--muted2)" }}>
                Te respondo dudas o reporto un bug a Lucas.
              </div>
            </div>
            {msgs.length > 0 && (
              <button
                onClick={reset}
                style={{
                  background: "transparent",
                  border: "1px solid var(--bd)",
                  borderRadius: "var(--r)",
                  padding: "2px 8px",
                  fontSize: 10,
                  color: "var(--muted2)",
                  cursor: "pointer",
                }}
                title="Empezar conversación nueva"
              >
                Nuevo
              </button>
            )}
            <button
              onClick={() => setOpen(false)}
              className="close-btn"
              style={{ marginLeft: 0 }}
              aria-label="Cerrar"
            >
              ✕
            </button>
          </div>

          {/* Body — mensajes */}
          <div
            ref={scrollRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: 14,
              fontSize: 12,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {msgs.length === 0 && (
              <div style={{ color: "var(--muted2)", fontSize: 11 }}>
                Hola. Escribime tu duda — ej: <em>"¿Cómo registro un adelanto?"</em>,
                <em>"No me deja editar un gasto"</em>, <em>"Para qué sirve la conciliación MP"</em>.
                Si no resuelvo, podés convertirlo en ticket para que Lucas lo atienda.
              </div>
            )}
            {msgs.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                  padding: "8px 10px",
                  borderRadius: "var(--r)",
                  background: m.role === "user" ? "var(--acc-soft, rgba(90, 143, 168, 0.15))" : "var(--s2)",
                  border: "1px solid var(--bd)",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.4,
                }}
              >
                {m.content}
              </div>
            ))}
            {loading && (
              <div style={{ color: "var(--muted2)", fontSize: 11, fontStyle: "italic" }}>
                Pensando…
              </div>
            )}
            {error && (
              <div
                style={{
                  padding: 8,
                  background: "rgba(248,81,73,0.1)",
                  border: "1px solid rgba(248,81,73,0.3)",
                  borderRadius: "var(--r)",
                  fontSize: 11,
                  color: "var(--danger)",
                }}
              >
                Error: {error}
              </div>
            )}
          </div>

          {/* Footer — input + acciones */}
          <div style={{ borderTop: "1px solid var(--bd)", padding: 10 }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void enviar();
                }
              }}
              placeholder="Escribí tu duda y enter…"
              rows={2}
              style={{
                width: "100%",
                resize: "none",
                padding: "6px 8px",
                background: "var(--s2)",
                border: "1px solid var(--bd)",
                borderRadius: "var(--r)",
                fontSize: 12,
                color: "var(--txt)",
                fontFamily: "inherit",
              }}
            />
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <button
                className="btn btn-acc btn-sm"
                onClick={() => void enviar()}
                disabled={!input.trim() || loading}
                style={{ flex: 1 }}
              >
                {loading ? "…" : "Enviar"}
              </button>
              {msgs.some((m) => m.role === "assistant") && !reporteOk && (
                <button
                  className="btn btn-sec btn-sm"
                  onClick={() => void reportarBug()}
                  disabled={reportando}
                  title="Persiste este chat como ticket para que Lucas lo atienda"
                >
                  {reportando ? "Enviando…" : "Reportar como bug"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
