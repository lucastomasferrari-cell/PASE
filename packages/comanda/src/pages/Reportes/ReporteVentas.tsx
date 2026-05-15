import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { db } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/Badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatARS, formatFechaAR, formatHoraAR } from '@/lib/format';
import { useReportesCtx } from './ReportesLayout';
import { downloadCSV } from '@/services/reportesService';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { cn } from '@/lib/utils';

// Reporte de ventas: tabla detallada con filtros + drill-down al detalle.
// Cobertura: todas las ventas del local en el rango — abiertas, cobradas, anuladas.
// Click navega a /pos/venta/<id> (para abiertas) o /pos/pedidos/<id> (cobradas).

interface VentaRow {
  id: number;
  numero_local: number;
  modo: string;
  estado: string;
  total: number;
  subtotal: number;
  descuento_total: number;
  propina: number;
  abierta_at: string;
  cobrada_at: string | null;
  cliente_nombre: string | null;
  canal_id: number;
  canal_nombre?: string | null;
  cajero_id: string | null;
  cajero_nombre?: string | null;
}

type FiltroEstado = 'todos' | 'abierta' | 'cobrada' | 'anulada' | 'enviada';

export function ReporteVentas() {
  const ctx = useReportesCtx();
  const navigate = useNavigate();
  const [ventas, setVentas] = useState<VentaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [estado, setEstado] = useState<FiltroEstado>('todos');
  const [modo, setModo] = useState<'todos' | 'salon' | 'mostrador' | 'pedidos'>('todos');
  const debouncedSearch = useDebouncedValue(search, 300);

  const reload = useCallback(async () => {
    if (!ctx.localId) return;
    setLoading(true);
    let q = db.from('ventas_pos')
      .select(`
        id, numero_local, modo, estado, total, subtotal, descuento_total, propina,
        abierta_at, cobrada_at, cliente_nombre, canal_id, cajero_id,
        canal:canales(nombre),
        cajero:rrhh_empleados!ventas_pos_cajero_id_fkey(nombre, apellido)
      `)
      .eq('local_id', ctx.localId)
      .is('deleted_at', null)
      .gte('abierta_at', ctx.desde)
      .lte('abierta_at', ctx.hasta)
      .order('numero_local', { ascending: false })
      .limit(500);
    if (estado !== 'todos') q = q.eq('estado', estado);
    if (modo !== 'todos') q = q.eq('modo', modo);
    if (debouncedSearch.trim()) {
      const s = debouncedSearch.trim();
      if (/^\d+$/.test(s)) q = q.or(`numero_local.eq.${Number(s)},cliente_nombre.ilike.%${s}%`);
      else q = q.ilike('cliente_nombre', `%${s}%`);
    }
    const { data } = await q;
    const mapped: VentaRow[] = (data ?? []).map((r) => {
      const row = r as unknown as VentaRow & {
        canal?: { nombre: string | null } | { nombre: string | null }[] | null;
        cajero?: { nombre: string | null; apellido: string | null } | { nombre: string | null; apellido: string | null }[] | null;
      };
      const canal = Array.isArray(row.canal) ? row.canal[0] : row.canal;
      const cajero = Array.isArray(row.cajero) ? row.cajero[0] : row.cajero;
      return {
        ...row,
        canal_nombre: canal?.nombre ?? null,
        cajero_nombre: cajero ? [cajero.apellido, cajero.nombre].filter(Boolean).join(' ') : null,
      } as VentaRow;
    });
    setVentas(mapped);
    setLoading(false);
  }, [ctx.localId, ctx.desde, ctx.hasta, debouncedSearch, estado, modo]);

  useEffect(() => { reload(); }, [reload]);

  useRealtimeTable({
    table: 'ventas_pos',
    onChange: () => reload(),
    scopeByLocal: true,
    debounceMs: 3000,
    enabled: !!ctx.localId,
  });

  // CSV export
  useEffect(() => {
    ctx.exportRef.current = () => {
      downloadCSV('reporte-ventas.csv',
        ['#', 'Fecha', 'Hora', 'Modo', 'Canal', 'Estado', 'Cliente', 'Cajero', 'Subtotal', 'Descuento', 'Propina', 'Total'],
        ventas.map((v) => [
          v.numero_local,
          formatFechaAR(v.abierta_at),
          formatHoraAR(v.abierta_at),
          v.modo,
          v.canal_nombre ?? '',
          v.estado,
          v.cliente_nombre ?? '',
          v.cajero_nombre ?? '',
          Number(v.subtotal).toFixed(2),
          Number(v.descuento_total).toFixed(2),
          Number(v.propina ?? 0).toFixed(2),
          Number(v.total).toFixed(2),
        ]));
    };
    return () => { ctx.exportRef.current = null; };
  }, [ctx.exportRef, ventas]);

  if (loading && ventas.length === 0) return <Skeleton className="h-64 w-full" />;

  // Totales
  const totalVentas = ventas.filter((v) => v.estado === 'cobrada').reduce((s, v) => s + Number(v.total), 0);
  const totalAnuladas = ventas.filter((v) => v.estado === 'anulada').reduce((s, v) => s + Number(v.total), 0);

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar # o cliente"
            className="pl-9 h-9"
          />
        </div>
        <Select value={estado} onValueChange={(v) => setEstado(v as FiltroEstado)}>
          <SelectTrigger className="h-9 w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los estados</SelectItem>
            <SelectItem value="abierta">Abierta</SelectItem>
            <SelectItem value="enviada">Enviada</SelectItem>
            <SelectItem value="cobrada">Cobrada</SelectItem>
            <SelectItem value="anulada">Anulada</SelectItem>
          </SelectContent>
        </Select>
        <Select value={modo} onValueChange={(v) => setModo(v as 'todos' | 'salon' | 'mostrador' | 'pedidos')}>
          <SelectTrigger className="h-9 w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los modos</SelectItem>
            <SelectItem value="salon">Salón</SelectItem>
            <SelectItem value="mostrador">Mostrador</SelectItem>
            <SelectItem value="pedidos">Pedidos</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto text-xs text-muted-foreground flex items-center gap-3">
          <span>{ventas.length} ventas</span>
          <span className="text-success">Cobrado: {formatARS(totalVentas)}</span>
          {totalAnuladas > 0 && <span className="text-destructive">Anuladas: {formatARS(totalAnuladas)}</span>}
        </div>
      </div>

      {/* Tabla */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {ventas.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground italic">
              {debouncedSearch ? 'Sin matches.' : 'Sin ventas en el rango.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs text-muted-foreground uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-2">#</th>
                  <th className="text-left px-4 py-2">Fecha</th>
                  <th className="text-left px-4 py-2">Modo · Canal</th>
                  <th className="text-left px-4 py-2">Estado</th>
                  <th className="text-left px-4 py-2">Cliente</th>
                  <th className="text-left px-4 py-2">Cajero</th>
                  <th className="text-right px-4 py-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {ventas.map((v) => {
                  const ruta = ['cobrada','anulada','enviada','lista','entregada'].includes(v.estado)
                    ? `/pos/pedidos/${v.id}` : `/pos/venta/${v.id}`;
                  return (
                    <tr
                      key={v.id}
                      className="border-t hover:bg-muted/30 cursor-pointer"
                      onClick={() => navigate(ruta)}
                    >
                      <td className="px-4 py-2.5 tabular-nums font-semibold">#{v.numero_local}</td>
                      <td className="px-4 py-2.5 text-xs">
                        <div>{formatFechaAR(v.abierta_at)}</div>
                        <div className="text-muted-foreground">{formatHoraAR(v.abierta_at)}</div>
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        <div className="capitalize">{v.modo}</div>
                        <div className="text-muted-foreground">{v.canal_nombre ?? '—'}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <EstadoBadge estado={v.estado} />
                      </td>
                      <td className="px-4 py-2.5 text-xs">{v.cliente_nombre ?? '—'}</td>
                      <td className="px-4 py-2.5 text-xs">{v.cajero_nombre ?? '—'}</td>
                      <td className={cn(
                        'px-4 py-2.5 text-right tabular-nums font-medium',
                        v.estado === 'anulada' && 'line-through text-muted-foreground',
                      )}>
                        {formatARS(v.total)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EstadoBadge({ estado }: { estado: string }) {
  const cfg: Record<string, { label: string; color: 'gray' | 'amber' | 'green' | 'red' | 'violet' }> = {
    abierta:             { label: 'Abierta',  color: 'gray' },
    enviada:             { label: 'En cocina', color: 'amber' },
    lista:               { label: 'Listo',    color: 'green' },
    entregada:           { label: 'Entregada',color: 'green' },
    cobrada:             { label: 'Cobrada',  color: 'green' },
    anulada:             { label: 'Anulada',  color: 'red' },
    necesita_aprobacion: { label: 'Por aprobar', color: 'violet' },
    programada:          { label: 'Programada', color: 'violet' },
  };
  const c = cfg[estado] ?? { label: estado, color: 'gray' as const };
  return <Badge variant={c.color}>{c.label}</Badge>;
}
