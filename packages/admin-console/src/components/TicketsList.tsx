import type { Ticket, EstadoTicket, PrioridadTicket, SistemaOrigen } from '@/lib/tickets';
import { cn } from '@/lib/cn';

interface Props {
  tickets: Ticket[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  filters: {
    estado: EstadoTicket | 'todos';
    sistema: SistemaOrigen | 'todos';
    prioridad: PrioridadTicket | 'todos';
  };
  setFilters: (f: Props['filters']) => void;
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

export function TicketsList({ tickets, selectedId, onSelect, loading, filters, setFilters }: Props) {
  return (
    <div className="w-96 shrink-0 border-r border-admin-border flex flex-col bg-admin-surface">
      {/* Filtros */}
      <div className="p-3 border-b border-admin-border space-y-2">
        <div className="grid grid-cols-3 gap-1.5">
          <Select
            value={filters.estado}
            onChange={(v) => setFilters({ ...filters, estado: v as EstadoTicket | 'todos' })}
            options={[
              ['todos', 'Todos'],
              ['abierto', 'Abiertos'],
              ['respondido', 'Respondidos'],
              ['cerrado', 'Cerrados'],
              ['duplicado', 'Duplicados'],
            ]}
          />
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
            {tickets.map((t) => (
              <li
                key={t.id}
                onClick={() => onSelect(t.id)}
                className={cn(
                  'p-3 cursor-pointer hover:bg-admin-border/30 transition-colors',
                  selectedId === t.id && 'bg-admin-accent/10 border-l-2 border-l-admin-accent',
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] uppercase tracking-wider text-admin-muted">{t.sistema}</span>
                  {t.prioridad && (
                    <span className={cn('text-[10px] px-1.5 py-0.5 rounded border', PRIORIDAD_COLORS[t.prioridad])}>
                      {t.prioridad}
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
            ))}
          </ul>
        )}
      </div>
    </div>
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
