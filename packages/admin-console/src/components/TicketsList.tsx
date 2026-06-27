import type { Ticket, EstadoTicket, PrioridadTicket, SistemaOrigen, AgentStatus } from '@/lib/tickets';
import { cn } from '@/lib/cn';
import { Inbox, GitPullRequest, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

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

const PRIORIDAD_COLORS: Record<PrioridadTicket, string> = {
  critica: 'bg-admin-danger/15 text-admin-danger border-admin-danger/30',
  alta: 'bg-admin-warn/15 text-admin-warn border-admin-warn/30',
  media: 'bg-admin-accent/15 text-admin-accent border-admin-accent/30',
  baja: 'bg-admin-border text-admin-muted border-admin-border',
};

const ESTADO_LABELS: Record<EstadoTicket, string> = {
  abierto: 'Abierto',
  respondido: 'Respondido',
  cerrado: 'Cerrado',
  duplicado: 'Duplicado',
};

const AGENT_BADGE: Partial<Record<AgentStatus, { label: string; icon: typeof Loader2; cls: string }>> = {
  pending: { label: 'En cola', icon: Loader2, cls: 'text-admin-muted bg-admin-border/40' },
  investigating: { label: 'Investigando', icon: Loader2, cls: 'text-admin-accent bg-admin-accent/15' },
  escalating: { label: 'Escalado', icon: Loader2, cls: 'text-admin-warn bg-admin-warn/15' },
  fixing: { label: 'Fixeando', icon: Loader2, cls: 'text-admin-accent bg-admin-accent/15' },
  pr_opened: { label: 'PR listo', icon: AlertCircle, cls: 'text-admin-warn bg-admin-warn/15' },
  resolved: { label: 'Resuelto', icon: CheckCircle2, cls: 'text-admin-success bg-admin-success/15' },
  failed: { label: 'Falló', icon: AlertCircle, cls: 'text-admin-danger bg-admin-danger/15' },
};

export function TicketsList({ tickets, selectedId, onSelect, loading, filters, setFilters, counts }: Props) {
  return (
    <div className="w-full md:w-96 shrink-0 border-r border-admin-border flex flex-col bg-admin-surface">
      {/* Pestañas rápidas */}
      <div className="flex border-b border-admin-border">
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
          <div className="p-4 text-sm text-admin-muted">Cargando…</div>
        ) : tickets.length === 0 ? (
          <div className="p-4 text-sm text-admin-muted">No hay tickets que coincidan con los filtros.</div>
        ) : (
          <ul className="divide-y divide-admin-border">
            {tickets.map((t) => {
              const agentBadge = t.agent_status ? AGENT_BADGE[t.agent_status] : null;
              const agentSpinning = ['pending', 'investigating', 'escalating', 'fixing'].includes(t.agent_status || '');
              return (
                <li
                  key={t.id}
                  onClick={() => onSelect(t.id)}
                  className={cn(
                    'p-3 cursor-pointer hover:bg-admin-border/30 transition-colors',
                    selectedId === t.id && 'bg-admin-accent/10 border-l-2 border-l-admin-accent',
                  )}
                >
                  <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                    <span className="text-[10px] normal-case tracking-wider text-admin-muted">{t.sistema}</span>
                    {t.prioridad && (
                      <span className={cn('text-[10px] px-1.5 py-0.5 rounded border', PRIORIDAD_COLORS[t.prioridad])}>
                        {t.prioridad}
                      </span>
                    )}
                    {agentBadge && (
                      <span className={cn('text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1', agentBadge.cls)}>
                        <agentBadge.icon className={cn('w-2.5 h-2.5', agentSpinning && 'animate-spin')} />
                        {agentBadge.label}
                      </span>
                    )}
                    <span className="text-[10px] text-admin-muted ml-auto">{ESTADO_LABELS[t.estado]}</span>
                  </div>
                  <div className="text-sm text-admin-text line-clamp-2 mb-1">{t.mensaje}</div>
                  <div className="text-[10px] text-admin-muted flex items-center gap-2">
                    <span className="truncate flex-1" title={t.autor_email ?? ''}>{t.autor_email || `User ${t.autor_user_id}`}</span>
                    <span>{new Date(t.created_at).toLocaleDateString('es-AR')}</span>
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
        'flex-1 px-2 py-3 text-xs flex flex-col items-center gap-1 border-b-2 transition-colors',
        active
          ? 'border-admin-accent text-admin-accent bg-admin-accent/5'
          : 'border-transparent text-admin-muted hover:text-admin-text hover:bg-admin-border/30',
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5" />
        <span className="font-medium">{label}</span>
      </div>
      {count > 0 && (
        <span className={cn(
          'text-[10px] px-1.5 py-0.5 rounded',
          highlight && !active ? 'bg-admin-warn text-admin-bg font-medium' : 'bg-admin-border text-admin-muted',
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
      className="w-full text-xs bg-admin-bg border border-admin-border rounded px-1.5 py-1 text-admin-text focus:outline-none focus:border-admin-accent"
    >
      {options.map(([val, label]) => (
        <option key={val} value={val}>{label}</option>
      ))}
    </select>
  );
}
