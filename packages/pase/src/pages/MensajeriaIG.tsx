// Pantalla de Mensajería de Instagram — supervisión y control del bot.
//
// Layout 2 columnas:
//   - Izquierda: lista de conversaciones con preview + badge no-leídos
//   - Derecha: detalle del thread + cliente + acciones
//
// Acciones disponibles:
//   - Tomar conversación (bot deja de responder, vos te hacés cargo)
//   - Devolver al bot
//   - Responder como humano (envía via endpoint del bot)
//   - Bloquear cliente
//   - Marcar como cerrada
//
// El endpoint /api/send vive en el bot (proyecto Vercel separado),
// PASE le pega con el JWT del usuario en el header. El bot valida JWT
// + permisos antes de enviar.

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { db } from "../lib/supabase";
import { tienePermiso } from "../lib/auth";
import { fmt_$ } from "../lib/utils";
import { EmptyState, InfoTooltip } from "../components/ui";
import { IGConfigModal } from "./mensajeria/IGConfigModal";
import { IGClienteModal } from "./mensajeria/IGClienteModal";
import { IGConexionPanel } from "./mensajeria/IGConexionPanel";
import { NotificacionesPushToggle } from "./mensajeria/NotificacionesPushToggle";
import type { Usuario } from "../types";

// URL del bot (deploy Vercel separado). Configurable por env.
const BOT_API_URL = (import.meta.env.VITE_IG_BOT_URL as string | undefined)
  || "https://pase-instagram-bot.vercel.app";

interface MensajeriaProps {
  user: Usuario;
}

interface ConversacionRow {
  id: number;
  tenant_id: string;
  estado: 'bot' | 'humano' | 'escalada' | 'cerrada' | 'spam';
  tomada_por: number | null;
  tomada_at: string | null;
  ticket_soporte_id: string | null;
  escalada_motivo: string | null;
  ultimo_mensaje_at: string;
  ultimo_mensaje_preview: string | null;
  no_leidos_admin: number;
  created_at: string;
  cliente_id: number;
  igsid: string;
  cliente_nombre: string | null;
  cliente_telefono: string | null;
  mensajes_count: number;
  primera_interaccion: string;
  bloqueado: boolean;
  tomada_por_nombre: string | null;
}

interface MensajeRow {
  id: number;
  conversacion_id: number;
  direccion: 'in' | 'out';
  origen: 'cliente' | 'bot' | 'humano';
  usuario_id: number | null;
  tipo: string;
  texto: string | null;
  media_url: string | null;
  ig_mid: string | null;
  llm_tokens_in: number | null;
  llm_tokens_out: number | null;
  llm_cost_usd: number | null;
  error: string | null;
  created_at: string;
}

type FiltroTab = 'todas' | 'no_leidas' | 'escaladas' | 'humano' | 'bloqueadas';

const ESTADO_BADGE: Record<ConversacionRow['estado'], { label: string; cls: string; icon: string }> = {
  bot:       { label: 'Bot',       cls: 'b-success',  icon: '🤖' },
  humano:    { label: 'Humano',    cls: 'b-warn',     icon: '🧑' },
  escalada:  { label: 'Escalada',  cls: 'b-danger',   icon: '🚨' },
  cerrada:   { label: 'Cerrada',   cls: 'b-muted',    icon: '✓' },
  spam:      { label: 'Spam',      cls: 'b-muted',    icon: '🚫' },
};

export default function MensajeriaIG({ user }: MensajeriaProps) {
  const [conversaciones, setConversaciones] = useState<ConversacionRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [mensajes, setMensajes] = useState<MensajeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtroTab, setFiltroTab] = useState<FiltroTab>('todas');
  const [respuesta, setRespuesta] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [accionLoading, setAccionLoading] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [clienteEditId, setClienteEditId] = useState<number | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  if (!tienePermiso(user, 'mensajeria')) {
    return (
      <div className="empty">
        Acceso denegado: necesitás permiso 'mensajeria' para entrar acá.
      </div>
    );
  }

  // Cargar lista de conversaciones
  const loadConversaciones = useCallback(async () => {
    setLoading(true);
    const { data } = await db.from('v_ig_conversaciones_admin')
      .select('*')
      .order('ultimo_mensaje_at', { ascending: false })
      .limit(100);
    setConversaciones((data as ConversacionRow[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => { void loadConversaciones(); }, [loadConversaciones]);

  // Cargar mensajes del thread seleccionado
  useEffect(() => {
    if (!selectedId) {
      setMensajes([]);
      return;
    }
    (async () => {
      const { data } = await db.from('ig_mensajes')
        .select('*')
        .eq('conversacion_id', selectedId)
        .order('created_at', { ascending: true })
        .limit(300);
      setMensajes((data as MensajeRow[]) || []);
      // Resetear contador de no-leídos
      await db.from('ig_conversaciones')
        .update({ no_leidos_admin: 0 })
        .eq('id', selectedId);
    })();
  }, [selectedId]);

  // Scroll to bottom cuando llegan mensajes nuevos
  useEffect(() => {
    if (mensajes.length > 0) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [mensajes.length]);

  // Realtime: cuando llega un mensaje nuevo, recargar lista y thread si corresponde
  useEffect(() => {
    const channel = db.channel('ig_mensajes_changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ig_mensajes' },
        async (payload) => {
          const nuevo = payload.new as MensajeRow;
          void loadConversaciones();
          if (nuevo.conversacion_id === selectedId) {
            setMensajes(prev => [...prev, nuevo]);
          }
        })
      .subscribe();
    return () => { void db.removeChannel(channel); };
  }, [selectedId, loadConversaciones]);

  // Filtrado
  const conversacionesFiltradas = useMemo(() => {
    return conversaciones.filter(c => {
      if (filtroTab === 'no_leidas') return c.no_leidos_admin > 0;
      if (filtroTab === 'escaladas') return c.estado === 'escalada';
      if (filtroTab === 'humano') return c.estado === 'humano';
      if (filtroTab === 'bloqueadas') return c.estado === 'spam' || c.bloqueado;
      return true;
    });
  }, [conversaciones, filtroTab]);

  const selectedConv = conversaciones.find(c => c.id === selectedId);

  // KPIs
  const kpis = useMemo(() => {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const conversacionesHoy = conversaciones.filter(c => new Date(c.ultimo_mensaje_at) >= hoy).length;
    const escaladas = conversaciones.filter(c => c.estado === 'escalada').length;
    const noLeidas = conversaciones.reduce((s, c) => s + c.no_leidos_admin, 0);
    const mensajesHoy = mensajes.filter(m => new Date(m.created_at) >= hoy).length;
    return { conversacionesHoy, escaladas, noLeidas, mensajesHoy };
  }, [conversaciones, mensajes]);

  // ─── Acciones ─────────────────────────────────────────────────────
  const setEstado = async (estado: ConversacionRow['estado']) => {
    if (!selectedId) return;
    setAccionLoading('estado');
    const updates: Partial<ConversacionRow> = { estado };
    if (estado === 'humano') {
      updates.tomada_por = user.id;
      updates.tomada_at = new Date().toISOString();
    } else if (estado === 'bot') {
      updates.tomada_por = null;
      updates.tomada_at = null;
    }
    await db.from('ig_conversaciones').update(updates).eq('id', selectedId);
    setAccionLoading(null);
    await loadConversaciones();
  };

  const bloquearCliente = async () => {
    if (!selectedConv) return;
    if (!confirm(`¿Bloquear a este cliente (${selectedConv.cliente_nombre || selectedConv.igsid})? No vamos a responder más sus mensajes.`)) return;
    setAccionLoading('bloquear');
    await db.from('ig_clientes')
      .update({ bloqueado: true, bloqueado_motivo: 'Bloqueado desde admin' })
      .eq('id', selectedConv.cliente_id);
    await db.from('ig_conversaciones').update({ estado: 'spam' }).eq('id', selectedConv.id);
    setAccionLoading(null);
    await loadConversaciones();
  };

  const enviarRespuestaHumano = async () => {
    if (!respuesta.trim() || !selectedConv) return;
    setEnviando(true);
    try {
      // Obtener JWT actual del user para autenticar al bot
      const { data: { session } } = await db.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        alert('Sesión expirada. Volvé a entrar.');
        return;
      }
      const resp = await fetch(`${BOT_API_URL}/api/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          conversacion_id: selectedConv.id,
          texto: respuesta.trim(),
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        alert('Error enviando: ' + (data?.error || `HTTP ${resp.status}`));
        return;
      }
      setRespuesta("");
      // Auto-tomar la conversación si estaba en 'bot'
      if (selectedConv.estado === 'bot') {
        await setEstado('humano');
      }
    } catch (e) {
      alert('Error: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setEnviando(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────
  return (
    <div>
      {/* Header */}
      <div className="ph-row">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div className="ph-title">Mensajería</div>
          <InfoTooltip maxWidth={340}>
            Panel para ver el historial de DMs de Instagram + tomar el control del
            bot cuando hace falta. Cuando una conversación está en estado "Bot",
            el bot atiende automáticamente. Si vos respondés, la pasamos a "Humano"
            y el bot se queda quieto hasta que la devuelvas.
          </InfoTooltip>
        </div>
        <div>
          <button className="btn btn-acc" onClick={() => setConfigOpen(true)}>
            ⚙ Configurar bot
          </button>
        </div>
      </div>

      {/* Panel de conexión Instagram (botón si no conectado / estado si conectado) */}
      <IGConexionPanel />

      {/* Toggle de notificaciones push (visible para cualquier user que llegó
          a Mensajería — el gate de permiso `mensajeria` ya filtró antes). */}
      <NotificacionesPushToggle />

      {/* KPIs */}
      <div className="grid4" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="kpi-label">Conversaciones hoy</div>
          <div className="kpi-value" style={{ fontSize: 22 }}>{kpis.conversacionesHoy}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Mensajes hoy</div>
          <div className="kpi-value" style={{ fontSize: 22 }}>{kpis.mensajesHoy}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Sin leer</div>
          <div className="kpi-value" style={{ fontSize: 22, color: kpis.noLeidas > 0 ? "var(--warn)" : "var(--muted2)" }}>
            {kpis.noLeidas}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Escaladas</div>
          <div className="kpi-value" style={{ fontSize: 22, color: kpis.escaladas > 0 ? "var(--danger)" : "var(--success)" }}>
            {kpis.escaladas}
          </div>
        </div>
      </div>

      {/* Layout 2 columnas */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "320px 1fr",
        gap: 12,
        height: "calc(100vh - 280px)",
        minHeight: 500,
      }}>
        {/* ─── COLUMNA IZQUIERDA: lista ─── */}
        <div className="panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden", margin: 0 }}>
          <div className="panel-hd" style={{ padding: "10px 14px" }}>
            <span className="panel-title" style={{ fontSize: 13 }}>
              {conversacionesFiltradas.length} de {conversaciones.length}
            </span>
          </div>
          <div style={{ display: "flex", gap: 4, padding: "8px 10px", flexWrap: "wrap", borderBottom: "1px solid var(--bd)" }}>
            {([
              ['todas', 'Todas'],
              ['no_leidas', `Nuevas${kpis.noLeidas > 0 ? ` (${kpis.noLeidas})` : ''}`],
              ['escaladas', `Escal.${kpis.escaladas > 0 ? ` (${kpis.escaladas})` : ''}`],
              ['humano', 'Humano'],
              ['bloqueadas', 'Bloq.'],
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setFiltroTab(tab as FiltroTab)}
                className={`btn btn-sm ${filtroTab === tab ? 'btn-acc' : 'btn-ghost'}`}
                style={{ fontSize: 10, padding: "3px 8px" }}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {loading ? (
              <div className="loading">Cargando...</div>
            ) : conversacionesFiltradas.length === 0 ? (
              <EmptyState icon="📭" title="Sin conversaciones" description={
                filtroTab === 'todas'
                  ? "Cuando alguien escriba al Instagram de Neko, va a aparecer acá."
                  : "Nada en este filtro."
              } />
            ) : (
              conversacionesFiltradas.map(c => {
                const badge = ESTADO_BADGE[c.estado];
                return (
                  <div
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    style={{
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--bd)",
                      cursor: "pointer",
                      background: selectedId === c.id ? "var(--acc-soft, rgba(117,170,219,0.1))" : undefined,
                      borderLeft: c.no_leidos_admin > 0 ? "3px solid var(--warn)" : "3px solid transparent",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>
                        {c.cliente_nombre || `@${c.igsid.slice(0, 8)}`}
                      </div>
                      <span className={`badge ${badge.cls}`} style={{ fontSize: 9 }}>
                        {badge.icon} {badge.label}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.ultimo_mensaje_preview || "—"}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4, display: "flex", justifyContent: "space-between" }}>
                      <span>{new Date(c.ultimo_mensaje_at).toLocaleString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                      {c.no_leidos_admin > 0 && (
                        <span style={{ background: "var(--warn)", color: "white", padding: "1px 6px", borderRadius: 8, fontSize: 9, fontWeight: 600 }}>
                          {c.no_leidos_admin} nuevo{c.no_leidos_admin > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ─── COLUMNA DERECHA: thread ─── */}
        <div className="panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden", margin: 0 }}>
          {!selectedConv ? (
            <EmptyState icon="💬" title="Elegí una conversación" description="Seleccioná un chat de la lista para verlo." />
          ) : (
            <>
              {/* Header del thread */}
              <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--bd)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <div
                  onClick={() => setClienteEditId(selectedConv.cliente_id)}
                  style={{ cursor: "pointer" }}
                  title="Click para editar memoria del cliente"
                >
                  <div style={{ fontWeight: 500, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                    {selectedConv.cliente_nombre || `@${selectedConv.igsid.slice(0, 12)}…`}
                    <span style={{ fontSize: 11, color: "var(--muted2)" }}>🧠 editar memoria</span>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted2)" }}>
                    {selectedConv.cliente_telefono && `📞 ${selectedConv.cliente_telefono} · `}
                    {selectedConv.mensajes_count} mensajes · desde {new Date(selectedConv.primera_interaccion).toLocaleDateString('es-AR')}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {selectedConv.estado === 'bot' && (
                    <button className="btn btn-sm btn-acc" onClick={() => setEstado('humano')} disabled={accionLoading === 'estado'}>
                      🧑 Tomar
                    </button>
                  )}
                  {selectedConv.estado === 'humano' && (
                    <button className="btn btn-sm btn-ghost" onClick={() => setEstado('bot')} disabled={accionLoading === 'estado'}>
                      🤖 Devolver al bot
                    </button>
                  )}
                  {selectedConv.estado === 'escalada' && (
                    <button className="btn btn-sm btn-acc" onClick={() => setEstado('humano')} disabled={accionLoading === 'estado'}>
                      🧑 Atender
                    </button>
                  )}
                  {selectedConv.estado !== 'cerrada' && (
                    <button className="btn btn-sm btn-ghost" onClick={() => setEstado('cerrada')} disabled={accionLoading === 'estado'}>
                      ✓ Cerrar
                    </button>
                  )}
                  {selectedConv.estado !== 'spam' && (
                    <button className="btn btn-sm btn-danger" onClick={bloquearCliente} disabled={accionLoading === 'bloquear'}>
                      🚫 Bloquear
                    </button>
                  )}
                </div>
              </div>

              {/* Mensajes */}
              <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", background: "var(--s2)" }}>
                {mensajes.map(m => {
                  const isOut = m.direccion === 'out';
                  return (
                    <div key={m.id} style={{
                      display: "flex",
                      justifyContent: isOut ? "flex-end" : "flex-start",
                      marginBottom: 10,
                    }}>
                      <div style={{
                        maxWidth: "70%",
                        padding: "8px 12px",
                        borderRadius: 12,
                        // Burbuja del cliente (in): usar celeste-100 que se adapta al
                        // tema (light: celeste pálido, dark: navy claro). Antes era
                        // "white" hardcoded → texto blanco sobre blanco en dark mode.
                        background: isOut
                          ? (m.origen === 'humano' ? "var(--success)" : "var(--acc)")
                          : "var(--pase-celeste-100)",
                        color: isOut ? "white" : "var(--pase-text)",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
                      }}>
                        {!isOut && (
                          <div style={{ fontSize: 9, color: "var(--pase-text-muted)", marginBottom: 2, fontWeight: 500 }}>
                            Cliente
                          </div>
                        )}
                        {isOut && m.origen === 'humano' && (
                          <div style={{ fontSize: 9, opacity: 0.8, marginBottom: 2 }}>
                            🧑 Humano
                          </div>
                        )}
                        {isOut && m.origen === 'bot' && (
                          <div style={{ fontSize: 9, opacity: 0.8, marginBottom: 2 }}>
                            🤖 Bot
                          </div>
                        )}
                        <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                          {m.texto || `[${m.tipo}]`}
                        </div>
                        {m.error && (
                          <div style={{ fontSize: 10, color: "var(--danger)", marginTop: 4 }}>
                            ⚠ {m.error}
                          </div>
                        )}
                        <div style={{
                          fontSize: 9,
                          opacity: isOut ? 0.85 : 0.6,
                          marginTop: 4,
                          color: isOut ? "white" : "var(--pase-text-muted)",
                        }}>
                          {new Date(m.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                          {m.llm_cost_usd && ` · ${fmt_$(Number(m.llm_cost_usd) * 1000)}/mil`}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={chatEndRef} />
              </div>

              {/* Input para responder como humano */}
              {selectedConv.estado !== 'cerrada' && selectedConv.estado !== 'spam' && (
                <div style={{ padding: "10px 14px", borderTop: "1px solid var(--bd)", background: "var(--bg)" }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <textarea
                      placeholder="Responder como humano..."
                      value={respuesta}
                      onChange={e => setRespuesta(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          enviarRespuestaHumano();
                        }
                      }}
                      rows={2}
                      style={{
                        flex: 1,
                        padding: "8px 10px",
                        borderRadius: 6,
                        border: "1px solid var(--bd)",
                        background: "var(--s2)",
                        fontSize: 13,
                        resize: "none",
                        fontFamily: "inherit",
                      }}
                    />
                    <button
                      className="btn btn-acc"
                      onClick={enviarRespuestaHumano}
                      disabled={enviando || !respuesta.trim()}
                    >
                      {enviando ? "Enviando..." : "Enviar"}
                    </button>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 4 }}>
                    {selectedConv.estado === 'bot'
                      ? "Si enviás, tomás la conversación (el bot deja de responder)."
                      : "Enter para enviar · Shift+Enter para nueva línea"}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Modales de configuración */}
      <IGConfigModal
        isOpen={configOpen}
        onClose={() => setConfigOpen(false)}
      />
      <IGClienteModal
        clienteId={clienteEditId}
        onClose={() => setClienteEditId(null)}
        onSaved={loadConversaciones}
      />
    </div>
  );
}
