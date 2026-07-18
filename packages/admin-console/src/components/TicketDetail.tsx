import { useEffect, useState } from 'react';
import { LifeBuoy, CheckCircle, RotateCcw, MessageSquare, Image as ImageIcon, Loader2, ArrowLeft } from 'lucide-react';
import {
  type Ticket,
  type PrioridadTicket,
  agregarComentario,
  cerrarTicket,
  reabrirTicket,
  setPrioridad,
  getScreenshotUrl,
} from '@/lib/tickets';
import { cn } from '@/lib/cn';
import { AgentPanel } from './AgentPanel';

interface Props {
  ticket: Ticket;
  onChange: () => void;   // pedir refetch al padre cuando cambia algo
  onBack?: () => void;    // mobile: volver al listado (oculta selección)
}

export function TicketDetail({ ticket, onChange, onBack }: Props) {
  const [comentario, setComentario] = useState('');
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [screenshotSignedUrl, setScreenshotSignedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!ticket.screenshot_url) {
      setScreenshotSignedUrl(null);
      return;
    }
    let cancelled = false;
    void getScreenshotUrl(ticket.screenshot_url).then((url) => {
      if (!cancelled) setScreenshotSignedUrl(url);
    });
    return () => { cancelled = true; };
  }, [ticket.id, ticket.screenshot_url]);

  async function onEnviar() {
    if (!comentario.trim() || sending) return;
    setSending(true);
    const { error } = await agregarComentario(ticket.id, comentario.trim());
    setSending(false);
    if (error) {
      alert('No se pudo enviar el comentario: ' + error);
      return;
    }
    setComentario('');
    onChange();
  }

  async function onCerrar() {
    if (closing) return;
    const motivo = window.prompt('Motivo del cierre (opcional):') ?? undefined;
    if (motivo === null) return;
    setClosing(true);
    const { error } = await cerrarTicket(ticket.id, motivo || undefined);
    setClosing(false);
    if (error) {
      alert('No se pudo cerrar: ' + error);
      return;
    }
    onChange();
  }

  async function onReabrir() {
    const { error } = await reabrirTicket(ticket.id);
    if (error) {
      alert('No se pudo reabrir: ' + error);
      return;
    }
    onChange();
  }

  async function onSetPrioridad(p: PrioridadTicket) {
    const { error } = await setPrioridad(ticket.id, p);
    if (error) {
      alert('No se pudo actualizar prioridad: ' + error);
      return;
    }
    onChange();
  }

  const isCerrado = ticket.estado === 'cerrado';
  const yaResuelto = ticket.estado === 'respondido' || ticket.estado === 'cerrado';

  return (
    <div className="flex-1 flex flex-col bg-admin-bg overflow-hidden">
      {/* Header — barra de estado del ticket. */}
      <header className="px-4 md:px-6 py-4 border-b border-admin-border bg-admin-surface">
        <div className="flex items-start gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="md:hidden w-9 h-9 rounded border border-admin-border hover:border-admin-accent/40 hover:bg-admin-accent/5 flex items-center justify-center text-admin-muted shrink-0 transition-colors"
              aria-label="Volver al listado"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <div className="icon-box w-9 h-9 rounded border border-admin-accent/20 flex items-center justify-center shrink-0">
            <LifeBuoy className="w-4 h-4 text-admin-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="mono text-[9px] uppercase tracking-widest text-admin-muted flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="normal-case tracking-normal text-admin-text">{ticket.autor_email || `User ${ticket.autor_user_id}`}</span>
              <span className="opacity-40">/</span>
              <span>{ticket.sistema}</span>
              {ticket.pantalla_origen && (
                <>
                  <span className="opacity-40">/</span>
                  <span className="text-admin-accent">{ticket.pantalla_origen}</span>
                </>
              )}
              <span className="opacity-40">/</span>
              <span>{new Date(ticket.created_at).toLocaleString('es-AR')}</span>
            </div>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {ticket.categoria && (
                <span className="mono text-[9px] uppercase tracking-tighter px-1.5 py-0.5 rounded border border-admin-border bg-slate-900/50 text-admin-muted">
                  {ticket.categoria}
                </span>
              )}
              <PrioridadPicker prioridad={ticket.prioridad} onChange={onSetPrioridad} />
              <span className="mono text-[9px] uppercase tracking-tighter px-1.5 py-0.5 rounded border border-admin-border bg-slate-900/50 text-admin-muted ml-auto">
                {ticket.estado}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Body scrollable */}
      <div className="flex-1 overflow-auto px-4 md:px-6 py-4 space-y-4">
        {/* Panel del agente — destacado arriba del todo cuando hay actividad. */}
        <AgentPanel ticket={ticket} onChange={onChange} />

        {/* Mensaje original — burbuja entrante (usuario). */}
        <div className="rounded border border-slate-800 bg-slate-900 p-4">
          <div className="label-sys mb-2">Mensaje original</div>
          <p className="text-sm whitespace-pre-wrap text-admin-text">{ticket.mensaje}</p>
        </div>

        {/* Screenshot si hay */}
        {ticket.screenshot_url && (
          <div className="rounded border border-slate-800 bg-slate-900 p-4">
            <div className="label-sys mb-2 flex items-center gap-1">
              <ImageIcon className="w-3 h-3" /> Captura adjunta
            </div>
            {screenshotSignedUrl ? (
              <a href={screenshotSignedUrl} target="_blank" rel="noreferrer">
                <img src={screenshotSignedUrl} alt="Captura del usuario" className="rounded border border-admin-border max-h-96 object-contain" />
              </a>
            ) : (
              <div className="mono text-[11px] uppercase tracking-widest text-admin-muted">Cargando captura…</div>
            )}
          </div>
        )}

        {/* Contexto JSONB si tiene contenido */}
        {Object.keys(ticket.contexto_jsonb || {}).length > 0 && (
          <details className="rounded border border-slate-800 bg-slate-900 p-4">
            <summary className="label-sys cursor-pointer">
              Contexto técnico
            </summary>
            <pre className="mono text-[11px] text-admin-text mt-2 overflow-auto">
              {JSON.stringify(ticket.contexto_jsonb, null, 2)}
            </pre>
          </details>
        )}

        {/* Respuesta automática del LLM — bloque de consola acento. */}
        {ticket.respuesta_llm && (
          <div className="rounded border border-admin-accent/30 bg-admin-accent/10 p-4">
            <div className="label-sys text-admin-accent mb-2">
              Auto-respuesta del asistente
            </div>
            <p className="text-sm whitespace-pre-wrap text-admin-accent">{ticket.respuesta_llm}</p>
          </div>
        )}

        {/* Comentarios — staff/superadmin acento; autor entrante slate. */}
        {ticket.comentarios.map((c, i) => {
          const esSuperadmin = c.autor_rol === 'superadmin';
          return (
            <div
              key={i}
              className={cn(
                'rounded border p-4',
                esSuperadmin
                  ? 'border-admin-accent/30 bg-admin-accent/10 ml-8'
                  : 'border-slate-800 bg-slate-900 mr-8',
              )}
            >
              <div className={cn(
                'label-sys mb-2 flex items-center gap-1',
                esSuperadmin && 'text-admin-accent',
              )}>
                <MessageSquare className="w-3 h-3" />
                {esSuperadmin ? 'Superadmin' : (c.autor_rol || 'Autor')}
                <span className="mono text-[9px] normal-case tracking-normal ml-auto opacity-70">{new Date(c.created_at).toLocaleString('es-AR')}</span>
              </div>
              <p className={cn('text-sm whitespace-pre-wrap', esSuperadmin ? 'text-admin-accent' : 'text-admin-text')}>{c.texto}</p>
            </div>
          );
        })}
      </div>

      {/* Composer + acciones */}
      {!isCerrado && (
        <footer className="border-t border-admin-border bg-admin-surface p-4 space-y-3">
          <textarea
            value={comentario}
            onChange={(e) => setComentario(e.target.value)}
            placeholder="Escribí tu respuesta al usuario…"
            rows={3}
            className="w-full px-0 py-2 bg-transparent text-admin-text text-sm resize-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={onEnviar}
              disabled={!comentario.trim() || sending}
              className="px-3 py-1.5 rounded border border-admin-accent/30 bg-admin-accent/10 text-admin-accent mono text-[10px] uppercase tracking-widest font-medium hover:bg-admin-accent/20 hover:border-admin-accent/60 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
            >
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />}
              Enviar respuesta
            </button>
            <button
              onClick={onCerrar}
              disabled={closing}
              className="px-3 py-1.5 rounded border border-admin-border text-admin-muted mono text-[10px] uppercase tracking-widest hover:text-admin-text hover:border-admin-border-strong hover:bg-admin-surface-2 disabled:opacity-40 flex items-center gap-1.5 transition-colors"
            >
              <CheckCircle className="w-3.5 h-3.5" />
              {yaResuelto ? 'Cerrar definitivamente' : 'Marcar como resuelto'}
            </button>
          </div>
        </footer>
      )}
      {isCerrado && (
        <footer className="border-t border-admin-border bg-admin-surface p-3 flex items-center justify-between mono text-[10px] text-admin-muted">
          <span>Ticket cerrado el {new Date(ticket.resuelto_at || ticket.updated_at).toLocaleString('es-AR')}.</span>
          <button onClick={onReabrir} className="text-admin-accent hover:text-admin-text uppercase tracking-widest flex items-center gap-1 transition-colors">
            <RotateCcw className="w-3 h-3" /> Reabrir
          </button>
        </footer>
      )}
    </div>
  );
}

function PrioridadPicker({ prioridad, onChange }: { prioridad: PrioridadTicket | null; onChange: (p: PrioridadTicket) => void }) {
  return (
    <select
      value={prioridad ?? 'media'}
      onChange={(e) => onChange(e.target.value as PrioridadTicket)}
      className="mono text-[9px] uppercase tracking-tighter bg-slate-900/50 border border-admin-border rounded px-1.5 py-0.5 text-admin-text focus:outline-none focus:border-admin-accent"
    >
      <option value="critica">Crítica</option>
      <option value="alta">Alta</option>
      <option value="media">Media</option>
      <option value="baja">Baja</option>
    </select>
  );
}
