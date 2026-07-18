// Mensajería IG — consola del bot de Instagram (web propia). Lee/escribe las
// tablas ig_* y manda mensajes manuales vía el endpoint /api/send de este mismo
// proyecto (donde Meta tiene configurado el webhook).
//
// Look "Cocina.OS Command Center" (17-jul-2026): dark command center — hero
// terminal, dos paneles (lista system-row + thread), etiquetas mono. Solo
// presentación; la lógica (hooks, servicios, handlers) no cambia.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Bot, User as UserIcon, Send, Lock, CheckCircle2, AlertTriangle, Hand,
  MessageSquare, Search, Settings, ArrowLeft, Terminal, AtSign,
} from 'lucide-react';
import {
  listCuentas, listConversaciones, listMensajes, marcarLeida,
  setEstado, bloquearCliente, enviarMensaje,
  type CuentaIG, type Conversacion, type Mensaje, type EstadoConversacion,
} from '@/lib/igService';
import { IGConfigDrawer } from '@/components/IGConfigDrawer';

const ESTADOS: { key: EstadoConversacion | 'todas'; label: string }[] = [
  { key: 'todas', label: 'Todas' },
  { key: 'bot', label: 'Bot' },
  { key: 'humano', label: 'Humano' },
  { key: 'escalada', label: 'Escalada' },
  { key: 'cerrada', label: 'Cerradas' },
];

// Tonos dark: tint + border por estado (se recolorean respecto del tema crema).
const ESTADO_CFG: Record<EstadoConversacion, { label: string; tono: string; icon: React.ReactNode }> = {
  bot:      { label: 'Bot',      tono: 'bg-brand-400/10 text-brand-400 border-brand-400/30', icon: <Bot className="h-3 w-3" /> },
  humano:   { label: 'Humano',   tono: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', icon: <UserIcon className="h-3 w-3" /> },
  escalada: { label: 'Escalada', tono: 'bg-amber-500/10 text-amber-400 border-amber-500/30', icon: <AlertTriangle className="h-3 w-3" /> },
  cerrada:  { label: 'Cerrada',  tono: 'bg-slate-800 text-dim-300 border-slate-700', icon: <CheckCircle2 className="h-3 w-3" /> },
  spam:     { label: 'Spam',     tono: 'bg-red-500/10 text-red-400 border-red-500/30', icon: <Lock className="h-3 w-3" /> },
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
function nombre(c: Conversacion) {
  return c.cliente_nombre || (c.ig_username ? `@${c.ig_username}` : `@${c.igsid.slice(0, 8)}`);
}

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
    const { data } = await listConversaciones({
      cuentaId: cuentaSel ?? undefined,
      estado: filtroEstado,
      limit: 200,
    });
    setConvs(data);
    setCargandoConvs(false);
    if (sel) {
      const updated = data.find((c) => c.id === sel.id);
      if (updated) setSel(updated);
      void reloadMsgs(sel.id);
    }
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
    <div className="flex-1 min-h-0 flex flex-col gap-4">
      {/* Hero terminal + selector de cuenta + config, en una línea */}
      <header className="flex items-center justify-between gap-3 shrink-0">
        <div className="mono flex items-baseline gap-2 min-w-0">
          <span className="text-brand-400 opacity-70">root@bot:~#</span>
          <h1 className="text-xl font-bold tracking-tight text-dim-50">
            instabot<span className="text-gold">.</span><span className="text-dim-300 font-light text-base">os</span>
          </h1>
          <span className="cursor" />
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {cuentas.length === 0 ? (
            <span className="mono text-[10px] uppercase tracking-widest text-dim-300">Sin cuentas conectadas</span>
          ) : (
            <select value={cuentaSel ?? ''} onChange={(e) => setCuentaSel(Number(e.target.value))}
                    className="mono text-[11px] text-brand-400 uppercase cursor-pointer pr-4">
              {cuentas.map((c) => (
                <option key={c.id} value={c.id}>@{c.ig_username ?? `cuenta ${c.id}`}</option>
              ))}
            </select>
          )}
          {cuentaSel && (
            <button onClick={() => setConfigOpen(true)} title="Configuración" aria-label="Configuración"
                    className="icon-box w-8 h-8 rounded border border-brand-400/20 hover:bg-brand-400/10 inline-flex items-center justify-center transition-colors">
              <Settings className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {cuentaSel === null ? (
        <div className="bg-carbon-800 border border-carbon-600 rounded p-10 text-center">
          <div className="icon-box inline-flex items-center justify-center w-14 h-14 rounded border border-brand-400/20 mb-4"><Bot className="h-7 w-7" /></div>
          <p className="mono text-[11px] uppercase tracking-widest text-dim-50">Sin cuentas conectadas</p>
          <p className="mono text-[10px] text-dim-300 mt-2 tracking-wide">Cuando conectes una cuenta de Instagram, vas a poder operarla desde acá.</p>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[360px_1fr] gap-4 flex-1 min-h-0">
          {/* Lista de conversaciones — en mobile se oculta cuando hay un chat abierto */}
          <aside className={`bg-carbon-800 border border-carbon-600 rounded flex-col overflow-hidden min-h-0 ${sel ? 'hidden lg:flex' : 'flex'}`}>
            <div className="p-3 border-b border-carbon-600 space-y-3">
              <div className="relative flex items-center">
                <Search className="absolute left-3 h-3.5 w-3.5 text-dim-300" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="BUSCAR…"
                       className="mono text-[10px] w-full pl-9 py-2 uppercase placeholder:text-dim-400" />
              </div>
              <div className="flex gap-4 overflow-x-auto scrollbar-hide border-b border-carbon-600 pb-2">
                {ESTADOS.map((s) => (
                  <button key={s.key} onClick={() => setFiltroEstado(s.key)}
                          className={`mono text-[9px] pb-1 tracking-widest uppercase shrink-0 transition-colors ${filtroEstado === s.key ? 'text-brand-400 border-b-2 border-brand-400' : 'text-dim-300 hover:text-dim-50'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-carbon-600">
              {cargandoConvs ? (
                <div className="py-12 text-center text-dim-300 mono text-[10px] uppercase tracking-widest">Cargando…</div>
              ) : filtradas.length === 0 ? (
                <div className="py-12 text-center text-dim-300 mono text-[10px] uppercase tracking-widest">Sin conversaciones</div>
              ) : (
                filtradas.map((c) => {
                  const activa = sel?.id === c.id;
                  return (
                    <button key={c.id} onClick={() => elegir(c)}
                            className={`system-row w-full text-left px-4 py-4 flex items-center gap-4 ${activa ? 'bg-brand-400/[0.08] border-l-2 border-brand-400' : ''}`}>
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0 border ${ESTADO_CFG[c.estado].tono}`}>
                        {(nombre(c)[0] ?? '?').toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-sm font-semibold text-dim-50 truncate">{nombre(c)}</span>
                          <span className="mono text-[9px] text-dim-300 shrink-0">{tiempoRelativo(c.ultimo_mensaje_at)}</span>
                        </div>
                        <p className="text-[11px] text-dim-300 mt-1 truncate">{c.ultimo_mensaje_preview ?? '(sin preview)'}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <span className={`mono text-[8px] px-2 py-0.5 rounded border uppercase tracking-tighter inline-flex items-center gap-1 ${ESTADO_CFG[c.estado].tono}`}>
                            {ESTADO_CFG[c.estado].icon}{ESTADO_CFG[c.estado].label}
                          </span>
                          {c.bloqueado && <Lock className="h-3 w-3 text-red-400" />}
                        </div>
                      </div>
                      {c.no_leidos_admin > 0 && (
                        <span className="shrink-0 bg-brand-400 text-carbon-900 mono text-[10px] font-bold rounded-full px-1.5 h-5 min-w-[20px] inline-flex items-center justify-center">{c.no_leidos_admin}</span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* Thread */}
          <section className={`bg-carbon-900 border border-carbon-600 rounded flex-col overflow-hidden min-h-0 ${!sel ? 'hidden lg:flex' : 'flex'}`}>
            {!sel ? (
              <div className="flex-1 grid place-items-center text-dim-300">
                <div className="text-center">
                  <MessageSquare className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  <p className="mono text-[10px] uppercase tracking-widest">Elegí una conversación</p>
                </div>
              </div>
            ) : (
              <>
                {/* Header del thread */}
                <div className="status-bar px-4 py-3 flex items-center gap-3 flex-wrap">
                  <button onClick={() => setSel(null)} aria-label="Volver a la lista"
                    className="lg:hidden -ml-1 p-1.5 rounded text-dim-300 hover:text-dim-50 hover:bg-brand-400/10 shrink-0 transition-colors">
                    <ArrowLeft className="h-5 w-5" />
                  </button>
                  <div className="icon-box w-9 h-9 rounded-full border border-brand-400/20 flex items-center justify-center shrink-0"><AtSign className="h-4 w-4" /></div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-dim-50 truncate">{nombre(sel)}</div>
                    <div className="mono text-[9px] text-dim-300 uppercase truncate">{sel.ig_username ? `@${sel.ig_username}` : `@${sel.igsid.slice(0, 16)}`} · {sel.mensajes_count} MSGS</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-auto">
                    {sel.estado === 'bot' && (
                      <BtnQ tono="brand" icon={<Hand className="h-3.5 w-3.5" />} label="Humano"
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
                <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 bg-carbon-900">
                  {cargandoMsgs ? (
                    <div className="text-center text-dim-300 mono text-[10px] uppercase tracking-widest py-8">Cargando…</div>
                  ) : mensajes.length === 0 ? (
                    <div className="text-center text-dim-300 mono text-[10px] uppercase tracking-widest py-8">Sin mensajes</div>
                  ) : (
                    mensajes.map((m) => {
                      const mio = m.direccion === 'out';
                      const burbuja = mio
                        ? (m.origen === 'bot' ? 'bg-brand-400/10 border-brand-400/30 text-brand-400' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400')
                        : 'bg-slate-900 border-slate-800 text-dim-50';
                      return (
                        <div key={m.id} className={`flex ${mio ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[75%] rounded border px-4 py-2 ${burbuja}`}>
                            <p className="text-sm whitespace-pre-wrap break-words">{m.texto}</p>
                            <div className="mono text-[8px] opacity-70 mt-1 inline-flex items-center gap-1">
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
                <div className="p-4 border-t border-carbon-600 bg-carbon-900">
                  {sel.estado !== 'humano' && (
                    <div className="mono text-[9px] text-dim-300 mb-2 inline-flex items-center gap-2 uppercase tracking-wide">
                      <Terminal className="h-3 w-3 text-brand-400" /> Para responder como humano, primero tocá "Humano".
                    </div>
                  )}
                  <div className="flex gap-3 items-end">
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2}
                              disabled={sel.estado !== 'humano' || sel.bloqueado}
                              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void enviar(); } }}
                              placeholder={sel.bloqueado ? 'Cliente bloqueado' : sel.estado === 'humano' ? 'Tu respuesta…' : 'Tomá la conversación para escribir'}
                              className="flex-1 mono text-xs py-2 resize-none placeholder:text-dim-400 disabled:opacity-40" />
                    <button onClick={() => void enviar()} disabled={enviando || !draft.trim() || sel.estado !== 'humano' || sel.bloqueado}
                            className="mono text-[10px] px-4 py-2 rounded border border-brand-400/30 text-brand-400 hover:bg-brand-400/10 inline-flex items-center gap-2 uppercase tracking-wide transition-colors disabled:opacity-40">
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
    brand: 'border-brand-400/40 text-brand-400 hover:bg-brand-400/10',
    red:   'border-red-500/40 text-red-400 hover:bg-red-500/10',
    ghost: 'border-slate-700 text-dim-300 hover:text-dim-50',
  }[tono];
  return (
    <button onClick={onClick} className={`mono text-[10px] px-3 py-1.5 rounded border inline-flex items-center gap-1.5 uppercase tracking-wide shrink-0 whitespace-nowrap transition-colors ${cls}`}>
      {icon}{label}
    </button>
  );
}
