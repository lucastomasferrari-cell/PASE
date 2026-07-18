// Panel destacado dentro del detalle del ticket cuando el auto-fix agent
// está procesando o ya terminó. Diseñado para ser visible y accionable
// desde mobile (botones grandes, info clara).

import { useState } from 'react';
import { ExternalLink, CheckCircle, Loader2, AlertCircle, Bot, DollarSign } from 'lucide-react';
import type { Ticket } from '@/lib/tickets';
import { marcarResuelto } from '@/lib/tickets';

interface Props {
  ticket: Ticket;
  onChange: () => void;
}

const STATUS_LABEL: Record<string, { label: string; icon: typeof Bot; color: string }> = {
  pending: { label: 'En cola', icon: Loader2, color: 'text-admin-muted' },
  investigating: { label: 'Investigando con Sonnet', icon: Loader2, color: 'text-admin-accent' },
  escalating: { label: 'Escalado a Opus', icon: Loader2, color: 'text-admin-warn' },
  fixing: { label: 'Escribiendo fix + tests', icon: Loader2, color: 'text-admin-accent' },
  pr_opened: { label: 'PR listo para aprobar', icon: AlertCircle, color: 'text-admin-warn' },
  resolved: { label: 'Resuelto y mergeado', icon: CheckCircle, color: 'text-admin-success' },
  failed: { label: 'Agent no pudo resolver', icon: AlertCircle, color: 'text-admin-danger' },
};

export function AgentPanel({ ticket, onChange }: Props) {
  const [marcando, setMarcando] = useState(false);

  if (!ticket.agent_status) return null;

  // STATUS_LABEL incluye todas las claves de AgentStatus + un fallback a
  // pending si llega algo raro. TS no-uncheckedIndexedAccess obliga a esto.
  const info = STATUS_LABEL[ticket.agent_status] ?? STATUS_LABEL.pending!;
  const Icon = info.icon;
  const procesando = ['pending', 'investigating', 'escalating', 'fixing'].includes(ticket.agent_status);
  const tieneprPropuesto = ticket.agent_status === 'pr_opened' && ticket.agent_pr_url;
  const resuelto = ticket.agent_status === 'resolved';

  async function onMarcarResuelto() {
    if (marcando) return;
    if (!window.confirm('¿Mergaste el PR en GitHub? Marcar como resuelto cierra el ticket.')) return;
    setMarcando(true);
    const { error } = await marcarResuelto(ticket.id);
    setMarcando(false);
    if (error) {
      alert('No se pudo marcar resuelto: ' + error);
      return;
    }
    onChange();
  }

  return (
    <div className="rounded border border-admin-accent/30 bg-admin-surface overflow-hidden">
      {/* Header con estado — barra de consola. */}
      <div className="px-4 py-3 bg-admin-accent/10 border-b border-admin-accent/30 flex items-center gap-2">
        <Bot className="w-4 h-4 text-admin-accent shrink-0" />
        <div className="mono text-[10px] uppercase tracking-widest text-admin-accent font-semibold">
          Auto-fix Agent
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Icon className={`w-3.5 h-3.5 ${info.color} ${procesando ? 'animate-spin' : ''}`} />
          <span className={`mono text-[10px] uppercase tracking-widest font-medium ${info.color}`}>{info.label}</span>
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-3 text-sm">
        {/* Info técnica */}
        <div className="grid grid-cols-2 gap-3">
          {ticket.agent_model_used && (
            <div>
              <div className="label-sys">Modelo</div>
              <div className="text-admin-text mono text-[11px] mt-0.5">{ticket.agent_model_used}</div>
            </div>
          )}
          {ticket.agent_cost_usd != null && (
            <div>
              <div className="label-sys flex items-center gap-1">
                <DollarSign className="w-3 h-3" />
                Costo
              </div>
              <div className="text-admin-text mono text-[11px] mt-0.5">
                ${Number(ticket.agent_cost_usd).toFixed(4)} USD
              </div>
            </div>
          )}
          {ticket.agent_started_at && (
            <div>
              <div className="label-sys">Empezó</div>
              <div className="text-admin-text mono text-[11px] mt-0.5">
                {new Date(ticket.agent_started_at).toLocaleString('es-AR')}
              </div>
            </div>
          )}
          {ticket.agent_finished_at && (
            <div>
              <div className="label-sys">Terminó</div>
              <div className="text-admin-text mono text-[11px] mt-0.5">
                {new Date(ticket.agent_finished_at).toLocaleString('es-AR')}
              </div>
            </div>
          )}
        </div>

        {/* Diff summary — bloque de consola. */}
        {ticket.agent_diff_summary && (
          <div className="rounded bg-slate-900 border border-slate-800 px-3 py-2">
            <div className="label-sys mb-1">Resumen del cambio</div>
            <div className="text-admin-text text-xs">{ticket.agent_diff_summary}</div>
          </div>
        )}

        {/* Botón "Abrir PR" + "Marcar resuelto" — pills outline. */}
        {tieneprPropuesto && (
          <div className="space-y-2">
            <a
              href={ticket.agent_pr_url!}
              target="_blank"
              rel="noreferrer"
              className="w-full px-4 py-3 rounded border border-admin-accent/30 bg-admin-accent/10 text-admin-accent mono text-[11px] uppercase tracking-widest font-medium hover:bg-admin-accent/20 hover:border-admin-accent/60 transition-all flex items-center justify-center gap-2 active:scale-[0.98]"
            >
              <ExternalLink className="w-4 h-4" />
              Abrir PR #{ticket.agent_pr_number} en GitHub
            </a>
            <button
              type="button"
              onClick={onMarcarResuelto}
              disabled={marcando}
              className="w-full px-4 py-3 rounded border border-admin-border text-admin-muted mono text-[11px] uppercase tracking-widest hover:text-admin-text hover:border-admin-border-strong hover:bg-admin-surface-2 disabled:opacity-40 flex items-center justify-center gap-2 active:scale-[0.98] transition-colors"
            >
              <CheckCircle className="w-4 h-4" />
              {marcando ? 'Marcando…' : 'Ya mergeé en GitHub → marcar resuelto'}
            </button>
            <div className="mono text-[10px] text-admin-muted text-center leading-relaxed">
              Tip: abrí el PR, revisá el diff, si está OK pegale "Merge" en GitHub. Después volvé acá y marcalo resuelto.
            </div>
          </div>
        )}

        {resuelto && (
          <div className="mono text-[11px] uppercase tracking-widest text-admin-success flex items-center gap-2">
            <CheckCircle className="w-4 h-4" />
            Cambio mergeado.
            {ticket.agent_pr_url && (
              <a href={ticket.agent_pr_url} target="_blank" rel="noreferrer" className="underline hover:text-admin-text">
                Ver PR
              </a>
            )}
          </div>
        )}

        {/* Log expandible — bloque de consola. */}
        {ticket.agent_log && ticket.agent_log.length > 0 && (
          <details className="text-xs">
            <summary className="mono text-[10px] uppercase tracking-widest text-admin-muted cursor-pointer hover:text-admin-text">
              Ver log ({ticket.agent_log.length} eventos)
            </summary>
            <pre className="mt-2 p-2 rounded bg-slate-900 border border-slate-800 mono text-[10px] text-admin-text overflow-auto max-h-64">
              {JSON.stringify(ticket.agent_log, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
