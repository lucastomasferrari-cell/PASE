import type { Ticket, EstadoTicket, PrioridadTicket, SistemaOrigen, AgentStatus } from '@/lib/tickets';
import { cn } from '@/lib/cn';
import {
  Inbox, GitPullRequest, CheckCircle2, AlertCircle, Loader2,
  MessageSquare, Copy, ChevronRight,
} from 'lucide-react';

export interface ListFilters {
  estado: EstadoTicket | 'todos';
  sistema: SistemaOrigen | 'todos';
  prioridad: PrioridadTicket | 'todos';
  agentStatus: AgentStatus | 'todos';
  /** Pestaña activa — controla los filtros básicos. */
  tab: 'abiertos' | 'prs' | 'todos';
}

interface Props {
  tickets: Ticket[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  filters: ListFilters;
  setFilters: (f: ListFilters) => void;
  /** Conteos por pestaña, para mostrar badges. */
  counts: { abiertos: number; prs: number; todos: number };
}

// Chip mono relleno slate con tinte semántico por prioridad.
const PRIORIDAD_COLORS: Record<PrioridadTicket, string> = {
  critica: 'bg-admin-danger/15 text-admin-danger border-admin-danger/30',
  alta: 'bg-admin-warn/15 text-admin-warn border-admin-warn/30',
  media: 'bg-admin-accent/15 text-admin-accent border-admin-accent/30',
  baja: 'bg-slate-900/50 text-admin-muted border-admin-border',
};

const ESTADO_LABELS: Record<EstadoTicket, string> = {
  abierto: 'Abierto',
  respondido: 'Respondido',
  cerrado: 'Cerrado',
  duplicado: 'Duplicado',
};

// Chip de estado — tinte semántico + borde.
const ESTADO_CHIP: Record<EstadoTicket, string> = {
  abierto: 'bg-admin-accent/10 text-admin-accent border-admin-accent/30',
  respondido: 'bg-admin-success/10 text-admin-success border-admin-success/30',
  cerrado: 'bg-slate-900/50 text-admin-muted border-admin-border',
  duplicado: 'bg-slate-900/50 text-admin-muted border-admin-border',
};

// Icono + tinte del icon-box, derivado del estado del ticket.
const ESTADO_ICON: Record<EstadoTicket, { icon: typeof Inbox; color: string }> = {
  abierto: { icon: Inbox, color: 'text-admin-accent' },
  respondido: { icon: MessageSquare, color: 'text-admin-success' },
  cerrado: { icon: CheckCircle2, color: 'text-admin-muted' },
  duplicado: { icon: Copy, color: 'text-admin-muted' },
};

const AGENT_BADGE: Partial<Record<AgentStatus, { label: string; icon: typeof Loader2; cls: string }>> = {
  pending: { label: 'En cola', icon: Loader2, cls: 'text-admin-muted bg-slate-900/50 border-admin-border' },
  investigating: { label: 'Investigando', icon: Loader2, cls: 'text-admin-accent bg-admin-accent/10 border-admin-accent/30' },
  escalating: { label: 'Escalado', icon: Loader2, cls: 'text-admin-warn bg-admin-warn/10 border-admin-warn/30' },
  fixing: { label: 'Fixeando', icon: Loader2, cls: 'text-admin-accent bg-admin-accent/10 border-admin-accent/30' },
  pr_opened: { label: 'PR listo', icon: AlertCircle, cls: 'text-admin-warn bg-admin-warn/10 border-admin-warn/30' },
  resolved: { label: 'Resuelto', icon: CheckCircle2, cls: 'text-admin-success bg-admin-success/10 border-admin-success/30' },
  failed: { label: 'Falló', icon: AlertCircle, cls: 'text-admin-danger bg-admin-danger/10 border-admin-danger/30' },
};

export function TicketsList({ tickets, selectedId, onSelect, loading, filters, setFilters, counts }: Props) {
  return (
    <div className="w-full md:w-96 shrink-0 border-r border-admin-border flex flex-col bg-admin-surface">
      {/* Cabecera de sección. */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <h2 className="font-mono text-[11px] font-semibold text-admin-accent tracking-[0.3em] uppercase whitespace-nowrap">
          Bandeja
        </h2>
        <div className="h-px flex-1 bg-gradient-to-r from-admin-border-strong to-transparent" />
      </div>

      {/* Pestañas rápidas */}
      <div className="flex border-b border-admin-border px-2">
        <TabBtn
          active={filters.tab === 'abiertos'}
          onClick={() => setFilters({ ...filters, tab: 'abiertos', estado: 'abierto', agentStatus: 'todos' })}
          icon={Inbox}
          label="Abiertos"
          count={counts.abiertos}
        />
        <TabBtn
          active={filters.tab === 'prs'}
          onClick={() => setFilters({ ...filters, tab: 'prs', estado: 'todos', agentStatus: 'pr_opened' })}
          icon={GitPullRequest}
          label="PRs pendientes"
          count={counts.prs}
          highlight={counts.prs > 0}
        />
        <TabBtn
          active={filters.tab === 'todos'}
          onClick={() => setFilters({ ...filters, tab: 'todos', estado: 'todos', agentStatus: 'todos' })}
          icon={CheckCircle2}
          label="Todos"
          count={counts.todos}
        />
      </div>

      {/* Filtros secundarios */}
      <div className="p-3 border-b border-admin-border">
        <div className="grid grid-cols-2 gap-1.5">
          <Select
            value={filters.sistema}
            onChange={(v) => setFilters({ ...filters, sistema: v as SistemaOrigen | 'todos' })}
            options={[
              ['todos', 'PASE+COMANDA'],
              ['pase', 'PASE'],
              ['comanda', 'COMANDA'],
            ]}
          />
          <Select
            value={filters.prioridad}
            onChange={(v) => setFilters({ ...filters, prioridad: v as PrioridadTicket | 'todos' })}
            options={[
              ['todos', 'Toda prioridad'],
              ['critica', 'Crítica'],
              ['alta', 'Alta'],
              ['media', 'Media'],
              ['baja', 'Baja'],
            ]}
          />
        </div>
      </div>

      {/* Lista */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-4 mono text-[11px] uppercase tracking-widest text-admin-muted">Cargando…</div>
        ) : tickets.length === 0 ? (
          <div className="p-4 mono text-[11px] uppercase tracking-widest text-admin-muted">Sin tickets para estos filtros.</div>
        ) : (
          <ul>
            {tickets.map((t) => {
              const agentBadge = t.agent_status ? AGENT_BADGE[t.agent_status] : null;
              const agentSpinning = ['pending', 'investigating', 'escalating', 'fixing'].includes(t.agent_status || '');
              const estadoIcon = ESTADO_ICON[t.estado];
              const EstadoIcon = estadoIcon.icon;
              return (
                <li
                  key={t.id}
                  onClick={() => onSelect(t.id)}
                  className={cn(
                    'system-row group px-4 py-4 flex items-start gap-3 cursor-pointer',
                    selectedId === t.id && 'bg-admin-accent/[0.08] border-l-2 border-l-admin-accent',
                  )}
                >
                  <div className="icon-box w-9 h-9 rounded border border-admin-accent/20 flex items-center justify-center shrink-0">
                    <EstadoIcon className={cn('w-4 h-4', estadoIcon.color)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                      <span className="mono text-[9px] uppercase tracking-tighter text-admin-muted opacity-70">{t.sistema}</span>
                      {t.prioridad && (
                        <span className={cn('mono text-[9px] uppercase tracking-tighter px-1.5 py-0.5 rounded border', PRIORIDAD_COLORS[t.prioridad])}>
                          {t.prioridad}
                        </span>
                      )}
                      <span className={cn('mono text-[9px] uppercase tracking-tighter px-1.5 py-0.5 rounded border ml-auto', ESTADO_CHIP[t.estado])}>
                        {ESTADO_LABELS[t.estado]}
                      </span>
                    </div>
                    <div className="text-base font-semibold text-admin-text group-hover:text-admin-accent transition-colors line-clamp-2 mb-1.5 leading-snug">
                      {t.mensaje}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="mono text-[9px] text-admin-muted truncate flex-1" title={t.autor_email ?? ''}>
                        {t.autor_email || `User ${t.autor_user_id}`}
                      </span>
                      <span className="mono text-[9px] text-admin-muted shrink-0">{new Date(t.created_at).toLocaleDateString('es-AR')}</span>
                      <ChevronRight className="w-3.5 h-3.5 text-admin-accent opacity-30 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all shrink-0" />
                    </div>
                    {agentBadge && (
                      <span className={cn('mt-2 mono text-[9px] uppercase tracking-tighter px-1.5 py-0.5 rounded border inline-flex items-center gap-1', agentBadge.cls)}>
                        <agentBadge.icon className={cn('w-2.5 h-2.5', agentSpinning && 'animate-spin')} />
                        {agentBadge.label}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

interface TabBtnProps {
  active: boolean;
  onClick: () => void;
  icon: typeof Inbox;
  label: string;
  count: number;
  highlight?: boolean;
}

function TabBtn({ active, onClick, icon: Icon, label, count, highlight }: TabBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 px-2 py-3 flex flex-col items-center gap-1.5 border-b-2 transition-colors',
        active
          ? 'border-admin-accent text-admin-accent'
          : 'border-transparent text-admin-muted hover:text-admin-text',
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5" />
        <span className="mono text-[10px] uppercase tracking-[0.15em] font-medium">{label}</span>
      </div>
      {count > 0 && (
        <span className={cn(
          'mono text-[9px] px-1.5 py-0.5 rounded border',
          highlight && !active
            ? 'bg-admin-warn/15 text-admin-warn border-admin-warn/30 font-medium'
            : 'bg-slate-900/50 text-admin-muted border-admin-border',
        )}>
          {count}
        </span>
      )}
    </button>
  );
}

interface SelectProps {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<readonly [string, string]>;
}

function Select({ value, onChange, options }: SelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full mono text-[10px] uppercase tracking-tighter bg-slate-900/50 border border-admin-border rounded px-2 py-1.5 text-admin-text focus:outline-none focus:border-admin-accent"
    >
      {options.map(([val, label]) => (
        <option key={val} value={val}>{label}</option>
      ))}
    </select>
  );
}
