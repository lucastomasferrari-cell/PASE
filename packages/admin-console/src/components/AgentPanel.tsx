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
    <div className="rounded-lg border-2 border-admin-accent/30 bg-admin-accent/5 overflow-hidden">
      {/* Header con estado */}
      <div className="px-4 py-3 bg-admin-accent/10 flex items-center gap-2">
        <Bot className="w-4 h-4 text-admin-accent shrink-0" />
        <div className="text-xs normal-case tracking-wider text-admin-accent font-medium">
          Auto-fix Agent
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Icon className={`w-3.5 h-3.5 ${info.color} ${procesando ? 'animate-spin' : ''}`} />
          <span className={`text-xs font-medium ${info.color}`}>{info.label}</span>
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-3 text-sm">
        {/* Info técnica */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          {ticket.agent_model_used && (
            <div>
              <div className="text-admin-muted">Modelo</div>
              <div className="text-admin-text font-mono text-[11px]">{ticket.agent_model_used}</div>
            </div>
          )}
          {ticket.agent_cost_usd != null && (
            <div>
              <div className="text-admin-muted flex items-center gap-1">
                <DollarSign className="w-3 h-3" />
                Costo
              </div>
              <div className="text-admin-text font-mono text-[11px]">
                ${Number(ticket.agent_cost_usd).toFixed(4)} USD
              </div>
            </div>
          )}
          {ticket.agent_started_at && (
            <div>
              <div className="text-admin-muted">Empezó</div>
              <div className="text-admin-text text-[11px]">
                {new Date(ticket.agent_started_at).toLocaleString('es-AR')}
              </div>
            </div>
          )}
          {ticket.agent_finished_at && (
            <div>
              <div className="text-admin-muted">Terminó</div>
              <div className="text-admin-text text-[11px]">
                {new Date(ticket.agent_finished_at).toLocaleString('es-AR')}
              </div>
            </div>
          )}
        </div>

        {/* Diff summary */}
        {ticket.agent_diff_summary && (
          <div className="rounded bg-admin-bg border border-admin-border px-3 py-2 text-xs text-admin-muted">
            <div className="text-[10px] normal-case tracking-wider mb-1">Resumen del cambio</div>
            <div className="text-admin-text">{ticket.agent_diff_summary}</div>
          </div>
        )}

        {/* Botón "Abrir PR" + "Marcar resuelto" */}
        {tieneprPropuesto && (
          <div className="space-y-2">
            <a
              href={ticket.agent_pr_url!}
              target="_blank"
              rel="noreferrer"
              className="w-full px-4 py-3 rounded bg-admin-accent text-white text-sm font-medium hover:opacity-90 transition-opacity flex items-center justify-center gap-2 active:scale-[0.98]"
            >
              <ExternalLink className="w-4 h-4" />
              Abrir PR #{ticket.agent_pr_number} en GitHub
            </a>
            <button
              type="button"
              onClick={onMarcarResuelto}
              disabled={marcando}
              className="w-full px-4 py-3 rounded border border-admin-border text-admin-text text-sm hover:bg-admin-border/40 disabled:opacity-40 flex items-center justify-center gap-2 active:scale-[0.98]"
            >
              <CheckCircle className="w-4 h-4" />
              {marcando ? 'Marcando…' : 'Ya mergeé en GitHub → marcar resuelto'}
            </button>
            <div className="text-[10px] text-admin-muted text-center">
              Tip: abrí el PR, revisá el diff, si está OK pegale "Merge" en GitHub. Después volvé acá y marcalo resuelto.
            </div>
          </div>
        )}

        {resuelto && (
          <div className="text-xs text-admin-success flex items-center gap-2">
            <CheckCircle className="w-4 h-4" />
            Cambio mergeado.
            {ticket.agent_pr_url && (
              <a href={ticket.agent_pr_url} target="_blank" rel="noreferrer" className="underline">
                Ver PR
              </a>
            )}
          </div>
        )}

        {/* Log expandible */}
        {ticket.agent_log && ticket.agent_log.length > 0 && (
          <details className="text-xs">
            <summary className="text-admin-muted cursor-pointer hover:text-admin-text">
              Ver log ({ticket.agent_log.length} eventos)
            </summary>
            <pre className="mt-2 p-2 rounded bg-admin-bg border border-admin-border text-[10px] overflow-auto max-h-64">
              {JSON.stringify(ticket.agent_log, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
