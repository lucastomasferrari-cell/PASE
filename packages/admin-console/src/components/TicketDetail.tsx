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
      {/* Header */}
      <header className="px-4 md:px-6 py-4 border-b border-admin-border">
        <div className="flex items-start gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="md:hidden w-9 h-9 rounded hover:bg-admin-border/40 flex items-center justify-center text-admin-muted shrink-0"
              aria-label="Volver al listado"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <div className="w-9 h-9 rounded bg-admin-accent/15 text-admin-accent flex items-center justify-center shrink-0">
            <LifeBuoy className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-admin-muted">
              {ticket.autor_email || `User ${ticket.autor_user_id}`}
              {' · '}
              <span className="uppercase tracking-wider">{ticket.sistema}</span>
              {ticket.pantalla_origen && (
                <>{' · '}<code className="text-admin-accent">{ticket.pantalla_origen}</code></>
              )}
              {' · '}
              {new Date(ticket.created_at).toLocaleString('es-AR')}
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              {ticket.categoria && (
                <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-admin-border text-admin-muted">
                  {ticket.categoria}
                </span>
              )}
              <PrioridadPicker prioridad={ticket.prioridad} onChange={onSetPrioridad} />
              <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-admin-border text-admin-muted ml-auto">
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

        {/* Mensaje original */}
        <div className="rounded border border-admin-border bg-admin-surface p-4">
          <div className="text-[10px] uppercase tracking-wider text-admin-muted mb-2">Mensaje original</div>
          <p className="text-sm whitespace-pre-wrap text-admin-text">{ticket.mensaje}</p>
        </div>

        {/* Screenshot si hay */}
        {ticket.screenshot_url && (
          <div className="rounded border border-admin-border bg-admin-surface p-4">
            <div className="text-[10px] uppercase tracking-wider text-admin-muted mb-2 flex items-center gap-1">
              <ImageIcon className="w-3 h-3" /> Captura adjunta
            </div>
            {screenshotSignedUrl ? (
              <a href={screenshotSignedUrl} target="_blank" rel="noreferrer">
                <img src={screenshotSignedUrl} alt="Captura del usuario" className="rounded border border-admin-border max-h-96 object-contain" />
              </a>
            ) : (
              <div className="text-xs text-admin-muted">Cargando captura…</div>
            )}
          </div>
        )}

        {/* Contexto JSONB si tiene contenido */}
        {Object.keys(ticket.contexto_jsonb || {}).length > 0 && (
          <details className="rounded border border-admin-border bg-admin-surface p-4">
            <summary className="text-[10px] uppercase tracking-wider text-admin-muted cursor-pointer">
              Contexto técnico
            </summary>
            <pre className="text-[11px] text-admin-text mt-2 overflow-auto">
              {JSON.stringify(ticket.contexto_jsonb, null, 2)}
            </pre>
          </details>
        )}

        {/* Respuesta automática del LLM */}
        {ticket.respuesta_llm && (
          <div className="rounded border border-admin-accent/30 bg-admin-accent/5 p-4">
            <div className="text-[10px] uppercase tracking-wider text-admin-accent mb-2">
              Auto-respuesta del asistente
            </div>
            <p className="text-sm whitespace-pre-wrap text-admin-text">{ticket.respuesta_llm}</p>
          </div>
        )}

        {/* Comentarios */}
        {ticket.comentarios.map((c, i) => {
          const esSuperadmin = c.autor_rol === 'superadmin';
          return (
            <div
              key={i}
              className={cn(
                'rounded border p-4',
                esSuperadmin
                  ? 'border-admin-accent/30 bg-admin-accent/5 ml-8'
                  : 'border-admin-border bg-admin-surface mr-8',
              )}
            >
              <div className="text-[10px] uppercase tracking-wider text-admin-muted mb-2 flex items-center gap-1">
                <MessageSquare className="w-3 h-3" />
                {esSuperadmin ? 'Superadmin' : (c.autor_rol || 'Autor')}
                <span className="ml-auto normal-case">{new Date(c.created_at).toLocaleString('es-AR')}</span>
              </div>
              <p className="text-sm whitespace-pre-wrap text-admin-text">{c.texto}</p>
            </div>
          );
        })}
      </div>

      {/* Composer + acciones */}
      {!isCerrado && (
        <footer className="border-t border-admin-border bg-admin-surface p-4 space-y-2">
          <textarea
            value={comentario}
            onChange={(e) => setComentario(e.target.value)}
            placeholder="Escribí tu respuesta al usuario…"
            rows={3}
            className="w-full px-3 py-2 rounded bg-admin-bg border border-admin-border text-admin-text text-sm focus:outline-none focus:border-admin-accent resize-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={onEnviar}
              disabled={!comentario.trim() || sending}
              className="px-3 py-1.5 rounded bg-admin-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity flex items-center gap-1.5"
            >
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />}
              Enviar respuesta
            </button>
            <button
              onClick={onCerrar}
              disabled={closing}
              className="px-3 py-1.5 rounded bg-admin-border text-admin-text text-sm hover:bg-admin-border/70 disabled:opacity-40 flex items-center gap-1.5"
            >
              <CheckCircle className="w-3.5 h-3.5" />
              {yaResuelto ? 'Cerrar definitivamente' : 'Marcar como resuelto'}
            </button>
          </div>
        </footer>
      )}
      {isCerrado && (
        <footer className="border-t border-admin-border bg-admin-surface p-3 flex items-center justify-between text-xs text-admin-muted">
          <span>Ticket cerrado el {new Date(ticket.resuelto_at || ticket.updated_at).toLocaleString('es-AR')}.</span>
          <button onClick={onReabrir} className="text-admin-accent hover:underline flex items-center gap-1">
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
      className="text-[10px] uppercase tracking-wider bg-admin-border border-0 rounded px-1.5 py-0.5 text-admin-text focus:outline-none"
    >
      <option value="critica">Crítica</option>
      <option value="alta">Alta</option>
      <option value="media">Media</option>
      <option value="baja">Baja</option>
    </select>
  );
}
