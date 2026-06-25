// Mensajería IG — supervisión y control del bot de Instagram desde Habitué.
// Backend del bot vive aparte (pase-instagram-bot.vercel.app, donde Meta tiene
// configurado el webhook). Esta UI lee/escribe las tablas ig_* y manda
// mensajes manuales vía el endpoint /api/send del bot.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Bot, User as UserIcon, Send, Lock, CheckCircle2, AlertTriangle, Hand,
  MessageSquare, ChevronRight, Search, Settings,
} from 'lucide-react';
import {
  listCuentas, listConversaciones, listMensajes, marcarLeida,
  setEstado, bloquearCliente, enviarMensaje,
  type CuentaIG, type Conversacion, type Mensaje, type EstadoConversacion,
} from '@/lib/igService';
import { IGConfigDrawer } from '@/components/IGConfigDrawer';

const ESTADOS: { key: EstadoConversacion | 'todas'; label: string; emoji?: string }[] = [
  { key: 'todas', label: 'Todas' },
  { key: 'bot', label: 'Bot', emoji: '🤖' },
  { key: 'humano', label: 'Humano', emoji: '🙋' },
  { key: 'escalada', label: 'Escalada', emoji: '⚠️' },
  { key: 'cerrada', label: 'Cerradas', emoji: '✅' },
];

const ESTADO_CFG: Record<EstadoConversacion, { label: string; tono: string; icon: React.ReactNode }> = {
  bot:      { label: 'Bot',      tono: 'bg-brand-100 text-brand-800 border-brand-200', icon: <Bot className="h-3 w-3" /> },
  humano:   { label: 'Humano',   tono: 'bg-emerald-100 text-emerald-800 border-emerald-200', icon: <UserIcon className="h-3 w-3" /> },
  escalada: { label: 'Escalada', tono: 'bg-amber-100 text-amber-800 border-amber-200', icon: <AlertTriangle className="h-3 w-3" /> },
  cerrada:  { label: 'Cerrada',  tono: 'bg-slate-100 text-slate-600 border-slate-200', icon: <CheckCircle2 className="h-3 w-3" /> },
  spam:     { label: 'Spam',     tono: 'bg-red-100 text-red-800 border-red-200', icon: <Lock className="h-3 w-3" /> },
};

function tiempoRelativo(iso: string) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `${min} min`;
  if (min < 60 * 24) return `${Math.floor(min / 60)} h`;
  return `${Math.floor(min / (60 * 24))} d`;
}
function horaCorta(iso: string) {
  return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}
function nombre(c: Conversacion) { return c.cliente_nombre || `@${c.igsid.slice(0, 8)}`; }

export function Mensajeria({ userId }: { userId: number }) {
  const [cuentas, setCuentas] = useState<CuentaIG[]>([]);
  const [cuentaSel, setCuentaSel] = useState<number | null>(null);
  const [convs, setConvs] = useState<Conversacion[]>([]);
  const [filtroEstado, setFiltroEstado] = useState<EstadoConversacion | 'todas'>('todas');
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<Conversacion | null>(null);
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [draft, setDraft] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [cargandoConvs, setCargandoConvs] = useState(true);
  const [cargandoMsgs, setCargandoMsgs] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Cargar cuentas IG
  useEffect(() => {
    void (async () => {
      const { data, error } = await listCuentas();
      if (error) toast.error(error);
      setCuentas(data);
      if (data.length > 0 && cuentaSel === null) setCuentaSel(data[0]!.id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cargar conversaciones
  const reloadConvs = useCallback(async () => {
    setCargandoConvs(true);
    const { data, error } = await listConversaciones({
      cuentaId: cuentaSel ?? undefined,
      estado: filtroEstado,
      limit: 200,
    });
    if (error) toast.error(error);
    setConvs(data);
    setCargandoConvs(false);
  }, [cuentaSel, filtroEstado]);

  useEffect(() => { if (cuentaSel) void reloadConvs(); }, [cuentaSel, reloadConvs]);

  // Cargar mensajes del thread
  const reloadMsgs = useCallback(async (convId: number) => {
    setCargandoMsgs(true);
    const { data } = await listMensajes(convId);
    setMensajes(data);
    setCargandoMsgs(false);
    setTimeout(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, 50);
  }, []);

  function elegir(c: Conversacion) {
    setSel(c);
    void reloadMsgs(c.id);
    if (c.no_leidos_admin > 0) void marcarLeida(c.id);
  }

  async function accion(p: Promise<{ error: string | null }>, okMsg: string) {
    const { error } = await p;
    if (error) { toast.error(error); return; }
    toast.success(okMsg);
    void reloadConvs();
    if (sel) void reloadMsgs(sel.id);
  }

  async function enviar() {
    if (!sel || !draft.trim() || enviando) return;
    setEnviando(true);
    const { ok, error } = await enviarMensaje({ conversacionId: sel.id, texto: draft.trim() });
    setEnviando(false);
    if (!ok) { toast.error(error ?? 'No se pudo enviar'); return; }
    setDraft('');
    void reloadMsgs(sel.id);
    void reloadConvs();
  }

  const filtradas = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return convs;
    return convs.filter((c) => nombre(c).toLowerCase().includes(q) || c.igsid.toLowerCase().includes(q));
  }, [convs, search]);

  return (
    <div className="space-y-3">
      {/* Selector de cuenta IG + acciones */}
      <div className="flex items-center gap-2 flex-wrap">
        {cuentas.map((c) => (
          <button key={c.id} onClick={() => setCuentaSel(c.id)}
                  className={`rounded-full px-3.5 py-1.5 text-sm font-medium border ${cuentaSel === c.id ? 'bg-brand-500 text-white border-brand-500' : 'border-ink/15 bg-white hover:border-brand-300'}`}>
            📸 @{c.ig_username ?? `cuenta ${c.id}`}
          </button>
        ))}
        {cuentas.length === 0 && (
          <span className="text-sm text-ink-muted">No hay cuentas de Instagram conectadas. (La conexión OAuth se hace por ahora desde PASE → Mensajería.)</span>
        )}
        {cuentaSel && (
          <button onClick={() => setConfigOpen(true)}
                  className="ml-auto rounded-lg border border-ink/15 bg-white hover:bg-ink/5 px-3 py-1.5 text-sm font-medium inline-flex items-center gap-1.5">
            <Settings className="h-4 w-4" /> Config del bot
          </button>
        )}
      </div>

      {cuentaSel === null ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-10 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-50 text-brand-500 mb-3"><Bot className="h-7 w-7" /></div>
          <p className="font-medium">Conectá tu Instagram desde PASE → Mensajería</p>
          <p className="text-sm text-ink-muted mt-1">Una vez conectado, vas a poder operarlo desde acá.</p>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[340px_1fr] gap-3 min-h-[60vh]">
          {/* Lista de conversaciones */}
          <aside className="rounded-2xl bg-white border border-ink/5 shadow-card flex flex-col overflow-hidden">
            <div className="p-3 border-b border-ink/5 space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-muted" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar…"
                       className="w-full rounded-lg border border-ink/15 bg-white pl-9 pr-3 py-1.5 text-sm" />
              </div>
              <div className="flex gap-1 overflow-x-auto">
                {ESTADOS.map((s) => (
                  <button key={s.key} onClick={() => setFiltroEstado(s.key)}
                          className={`shrink-0 text-xs px-2.5 py-1 rounded-full border ${filtroEstado === s.key ? 'bg-brand-500 text-white border-brand-500' : 'bg-white border-ink/15 text-ink-soft'}`}>
                    {s.emoji} {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-ink/5">
              {cargandoConvs ? (
                <div className="py-12 text-center text-ink-muted text-sm">Cargando…</div>
              ) : filtradas.length === 0 ? (
                <div className="py-12 text-center text-ink-muted text-sm">Sin conversaciones</div>
              ) : (
                filtradas.map((c) => {
                  const activa = sel?.id === c.id;
                  return (
                    <button key={c.id} onClick={() => elegir(c)}
                            className={`w-full text-left p-3 flex items-start gap-2.5 hover:bg-brand-50/40 ${activa ? 'bg-brand-50' : ''}`}>
                      <div className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 grid place-items-center font-medium text-sm shrink-0">
                        {(nombre(c)[0] ?? '?').toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-medium text-sm truncate">{nombre(c)}</span>
                          <span className="text-[11px] text-ink-muted shrink-0">{tiempoRelativo(c.ultimo_mensaje_at)}</span>
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border inline-flex items-center gap-0.5 ${ESTADO_CFG[c.estado].tono}`}>
                            {ESTADO_CFG[c.estado].icon}{ESTADO_CFG[c.estado].label}
                          </span>
                          {c.bloqueado && <Lock className="h-3 w-3 text-red-500" />}
                        </div>
                        <p className="text-xs text-ink-muted mt-1 line-clamp-2">{c.ultimo_mensaje_preview ?? '(sin preview)'}</p>
                      </div>
                      {c.no_leidos_admin > 0 && (
                        <span className="shrink-0 bg-brand-500 text-white text-[10px] font-semibold rounded-full px-1.5 py-0.5 min-w-[20px] text-center">{c.no_leidos_admin}</span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* Thread */}
          <section className="rounded-2xl bg-white border border-ink/5 shadow-card flex flex-col overflow-hidden">
            {!sel ? (
              <div className="flex-1 grid place-items-center text-ink-muted">
                <div className="text-center">
                  <MessageSquare className="h-10 w-10 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">Elegí una conversación</p>
                </div>
              </div>
            ) : (
              <>
                {/* Header del thread */}
                <div className="p-3 border-b border-ink/5 flex items-center gap-2 flex-wrap">
                  <div className="w-9 h-9 rounded-full bg-brand-100 text-brand-700 grid place-items-center font-medium text-sm shrink-0">{(nombre(sel)[0] ?? '?').toUpperCase()}</div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{nombre(sel)}</div>
                    <div className="text-[11px] text-ink-muted">@{sel.igsid.slice(0, 16)} · {sel.mensajes_count} mensajes</div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {sel.estado === 'bot' && (
                      <BtnQ tono="brand" icon={<Hand className="h-3.5 w-3.5" />} label="Tomar como humano"
                            onClick={() => void accion(setEstado(sel.id, 'humano', userId), 'Tomaste la conversación')} />
                    )}
                    {sel.estado === 'humano' && (
                      <BtnQ tono="ghost" icon={<Bot className="h-3.5 w-3.5" />} label="Devolver al bot"
                            onClick={() => void accion(setEstado(sel.id, 'bot'), 'Devuelta al bot')} />
                    )}
                    {sel.estado !== 'cerrada' && (
                      <BtnQ tono="ghost" icon={<CheckCircle2 className="h-3.5 w-3.5" />} label="Cerrar"
                            onClick={() => void accion(setEstado(sel.id, 'cerrada'), 'Conversación cerrada')} />
                    )}
                    {!sel.bloqueado ? (
                      <BtnQ tono="red" icon={<Lock className="h-3.5 w-3.5" />} label="Bloquear"
                            onClick={() => { if (window.confirm('Bloquear al cliente?')) void accion(bloquearCliente(sel.cliente_id, true), 'Cliente bloqueado'); }} />
                    ) : (
                      <BtnQ tono="ghost" icon={<Lock className="h-3.5 w-3.5" />} label="Desbloquear"
                            onClick={() => void accion(bloquearCliente(sel.cliente_id, false), 'Cliente desbloqueado')} />
                    )}
                  </div>
                </div>

                {/* Mensajes */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2 bg-crema">
                  {cargandoMsgs ? (
                    <div className="text-center text-ink-muted text-sm py-8">Cargando…</div>
                  ) : mensajes.length === 0 ? (
                    <div className="text-center text-ink-muted text-sm py-8">Sin mensajes</div>
                  ) : (
                    mensajes.map((m) => {
                      const mio = m.direccion === 'out';
                      const burbuja = mio
                        ? (m.origen === 'bot' ? 'bg-brand-100 text-brand-900 border-brand-200' : 'bg-emerald-100 text-emerald-900 border-emerald-200')
                        : 'bg-white text-ink border-ink/10';
                      return (
                        <div key={m.id} className={`flex ${mio ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[70%] rounded-2xl border px-3 py-2 ${burbuja}`}>
                            <p className="text-sm whitespace-pre-wrap break-words">{m.texto}</p>
                            <div className="text-[10px] opacity-70 mt-0.5 inline-flex items-center gap-1">
                              {mio && (m.origen === 'bot' ? <Bot className="h-2.5 w-2.5" /> : <UserIcon className="h-2.5 w-2.5" />)}
                              {horaCorta(m.enviado_at)}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Composer */}
                <div className="p-3 border-t border-ink/5 bg-white">
                  {sel.estado !== 'humano' && (
                    <div className="text-[11px] text-ink-muted mb-2 inline-flex items-center gap-1">
                      <ChevronRight className="h-3 w-3" /> Para responder como humano, primero tocá "Tomar como humano".
                    </div>
                  )}
                  <div className="flex gap-2">
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2}
                              disabled={sel.estado !== 'humano' || sel.bloqueado}
                              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void enviar(); } }}
                              placeholder={sel.bloqueado ? 'Cliente bloqueado' : sel.estado === 'humano' ? 'Tu respuesta…' : 'Tomá la conversación para escribir'}
                              className="flex-1 rounded-lg border border-ink/15 px-3 py-2 text-sm resize-none disabled:bg-ink/5" />
                    <button onClick={() => void enviar()} disabled={enviando || !draft.trim() || sel.estado !== 'humano' || sel.bloqueado}
                            className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3 py-2 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-40">
                      <Send className="h-4 w-4" /> {enviando ? '…' : 'Enviar'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {configOpen && cuentaSel && (
        <IGConfigDrawer cuentaId={cuentaSel} onClose={() => setConfigOpen(false)} />
      )}
    </div>
  );
}

function BtnQ({ tono, icon, label, onClick }: { tono: 'brand' | 'red' | 'ghost'; icon: React.ReactNode; label: string; onClick: () => void }) {
  const cls = {
    brand: 'bg-brand-500 hover:bg-brand-600 text-white border-transparent',
    red:   'bg-white hover:bg-red-50 text-red-700 border-red-200',
    ghost: 'bg-white hover:bg-ink/5 text-ink-soft border-ink/15',
  }[tono];
  return (
    <button onClick={onClick} className={`text-xs px-2.5 py-1.5 rounded-lg border inline-flex items-center gap-1 font-medium ${cls}`}>
      {icon}{label}
    </button>
  );
}
