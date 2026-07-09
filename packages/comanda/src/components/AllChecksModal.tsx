import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import {
  buscarChecks, sumaChecks,
  type AllChecksFilter, type PeriodoFiltro,
} from '@/services/allChecksService';
import type { VentaPos, ModoVenta, EstadoVenta } from '@/types/database';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CanalBadge } from '@/components/CanalBadge';
import { EstadoVentaBadge } from '@/components/EstadoBadge';
import { formatARS, formatHoraAR, formatFechaAR } from '@/lib/format';

export interface AllChecksInitialFilters {
  modo?: ModoVenta | 'todos';
  estado?: EstadoVenta | 'cualquiera';
  periodo?: PeriodoFiltro;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Filtros iniciales cuando el modal se abre. Se aplican solo al abrir. */
  initialFilters?: AllChecksInitialFilters;
}

export function AllChecksModal({ open, onOpenChange, initialFilters }: Props) {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [modo, setModo] = useState<ModoVenta | 'todos'>(initialFilters?.modo ?? 'todos');
  const [estado, setEstado] = useState<EstadoVenta | 'cualquiera'>(initialFilters?.estado ?? 'cualquiera');
  const [periodo, setPeriodo] = useState<PeriodoFiltro>(initialFilters?.periodo ?? 'hoy');
  const [sort, setSort] = useState<'recientes' | 'antiguas' | 'mayor' | 'menor'>('recientes');
  const [results, setResults] = useState<VentaPos[]>([]);
  const [loading, setLoading] = useState(false);

  const filter: AllChecksFilter | null = useMemo(() => {
    if (localId === null) return null;
    return { localId, query, modo, estado, periodo, sort };
  }, [localId, query, modo, estado, periodo, sort]);

  const reload = useCallback(async () => {
    if (!filter) return;
    setLoading(true);
    const { data } = await buscarChecks(filter);
    setResults(data);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setModo(initialFilters?.modo ?? 'todos');
    setEstado(initialFilters?.estado ?? 'cualquiera');
    setPeriodo(initialFilters?.periodo ?? 'hoy');
  }, [open, initialFilters?.modo, initialFilters?.estado, initialFilters?.periodo]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(reload, 250);
    return () => clearTimeout(t);
  }, [open, reload]);

  // Atajo /  para abrir cuando NO está open (el caller monta esto)
  // Esc cierra (Dialog ya lo maneja por default).

  function clickRow(v: VentaPos) {
    onOpenChange(false);
    navigate(`/pos/venta/${v.id}`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[95vw] max-h-[90vh] flex flex-col p-0 gap-0">
        {/* Header — el cerrar (X) lo trae DialogContent por default */}
        <div className="px-6 py-4 border-b border-border">
          <DialogTitle className="text-lg font-semibold">Todas las cuentas</DialogTitle>
        </div>

        {/* Filtros */}
        <div className="px-6 py-3 border-b border-border space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              autoFocus
              placeholder="Buscar por número, cliente, teléfono…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-10 h-11"
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            <Select value={modo} onValueChange={(v) => setModo(v as ModoVenta | 'todos')}>
              <SelectTrigger className="w-[140px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos los modos</SelectItem>
                <SelectItem value="salon">Salón</SelectItem>
                <SelectItem value="mostrador">Mostrador</SelectItem>
                <SelectItem value="pedidos">Pedidos</SelectItem>
              </SelectContent>
            </Select>
            <Select value={estado} onValueChange={(v) => setEstado(v as EstadoVenta | 'cualquiera')}>
              <SelectTrigger className="w-[160px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cualquiera">Cualquier estado</SelectItem>
                <SelectItem value="abierta">Abiertas</SelectItem>
                <SelectItem value="enviada">En cocina</SelectItem>
                <SelectItem value="lista">Listas</SelectItem>
                <SelectItem value="cobrada">Cobradas</SelectItem>
                <SelectItem value="anulada">Anuladas</SelectItem>
              </SelectContent>
            </Select>
            <Select value={periodo} onValueChange={(v) => setPeriodo(v as PeriodoFiltro)}>
              <SelectTrigger className="w-[140px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="hoy">Hoy</SelectItem>
                <SelectItem value="ayer">Ayer</SelectItem>
                <SelectItem value="semana">Última semana</SelectItem>
                <SelectItem value="mes">Último mes</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
              <SelectTrigger className="w-[180px] h-9 ml-auto"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="recientes">Más recientes</SelectItem>
                <SelectItem value="antiguas">Más antiguas</SelectItem>
                <SelectItem value="mayor">Mayor monto</SelectItem>
                <SelectItem value="menor">Menor monto</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Stats bar */}
        <div className="px-6 py-2 border-b border-border bg-muted/40 text-xs text-muted-foreground flex items-center justify-between">
          <span>{loading ? 'Buscando…' : `${results.length} cuentas`}</span>
          <span>Suma: <strong className="tabular-nums text-foreground">{formatARS(sumaChecks(results))}</strong></span>
        </div>

        {/* Tabla */}
        <div className="flex-1 overflow-y-auto">
          {results.length === 0 && !loading ? (
            <div className="py-16 text-center text-muted-foreground">Sin resultados.</div>
          ) : (
            <div>
              <div className="grid grid-cols-[100px_120px_1fr_140px_140px_140px] gap-3 px-6 py-2 border-b border-border bg-muted/30 text-xs font-medium text-muted-foreground uppercase tracking-wide sticky top-0">
                <div>Nº / Mesa</div>
                <div>Modo</div>
                <div>Cliente / Hora</div>
                <div>Mozo</div>
                <div className="text-right">Total</div>
                <div>Estado</div>
              </div>
              {results.map((v, idx) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => clickRow(v)}
                  className={`w-full grid grid-cols-[100px_120px_1fr_140px_140px_140px] gap-3 px-6 py-3 items-center text-sm text-left hover:bg-muted/30 transition-colors ${
                    idx !== results.length - 1 ? 'border-b border-border' : ''
                  }`}
                >
                  <div className="font-semibold">
                    #{v.numero_local}
                    {v.mesa_id && <div className="text-xs text-muted-foreground">Mesa {v.mesa_id}</div>}
                  </div>
                  <div><CanalBadge slug={v.modo} /></div>
                  <div className="min-w-0">
                    <div className="truncate">{v.cliente_nombre ?? 'Sin nombre'}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatFechaAR(v.created_at)} · {formatHoraAR(v.created_at)}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">{v.mozo_id ?? '—'}</div>
                  <div className="text-right tabular-nums font-medium">{formatARS(v.total)}</div>
                  <div><EstadoVentaBadge estado={v.estado} /></div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
