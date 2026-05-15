import { useEffect, useState, useCallback } from 'react';
import { ExternalLink, CheckCircle2, XCircle, Calendar } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/Badge';
import { Input } from '@/components/ui/input';
import { formatARS, formatFechaAR, formatHoraAR } from '@/lib/format';
import { cn } from '@/lib/utils';

// Vista simple de Conciliación MP en POS — para que el dueño/manager vea
// los cobros MP del local + estado de conciliación con ventas/gastos.
// La conciliación completa vive en PASE (módulo grande), pero esta pantalla
// del POS deja ver rápido qué entró y qué quedó sin matchear.

interface MpMov {
  id: number;
  fecha: string;
  tipo: string;
  descripcion: string | null;
  monto: number;
  monto_bruto: number | null;
  estado: string;
  medio_pago: string | null;
  conciliado: boolean;
  vinculo_tipo: string | null;
  vinculo_id: number | null;
  mp_status: string | null;
}

const HOY = new Date();
const HACE_7 = new Date(HOY.getTime() - 7 * 24 * 60 * 60 * 1000);

type FiltroConciliado = 'todos' | 'conciliado' | 'pendiente';

export function ConciliacionMpView() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [movs, setMovs] = useState<MpMov[]>([]);
  const [loading, setLoading] = useState(true);
  const [desde, setDesde] = useState(HACE_7.toISOString().slice(0, 10));
  const [hasta, setHasta] = useState(HOY.toISOString().slice(0, 10));
  const [filtro, setFiltro] = useState<FiltroConciliado>('todos');

  const reload = useCallback(async () => {
    if (!localId) return;
    setLoading(true);
    const desdeIso = new Date(desde + 'T00:00:00').toISOString();
    const hastaIso = new Date(hasta + 'T23:59:59').toISOString();

    let q = db.from('mp_movimientos')
      .select('id, fecha, tipo, descripcion, monto, monto_bruto, estado, medio_pago, conciliado, vinculo_tipo, vinculo_id, mp_status')
      .eq('local_id', localId)
      .gte('fecha', desdeIso)
      .lte('fecha', hastaIso)
      .eq('anulado', false)
      .eq('ignorado', false)
      .order('fecha', { ascending: false })
      .limit(300);
    if (filtro === 'conciliado') q = q.eq('conciliado', true);
    if (filtro === 'pendiente') q = q.eq('conciliado', false);

    const { data } = await q;
    setMovs((data ?? []) as MpMov[]);
    setLoading(false);
  }, [localId, desde, hasta, filtro]);

  useEffect(() => { reload(); }, [reload]);

  const totalIngresos = movs.filter((m) => Number(m.monto) > 0).reduce((s, m) => s + Number(m.monto), 0);
  const totalEgresos = movs.filter((m) => Number(m.monto) < 0).reduce((s, m) => s + Math.abs(Number(m.monto)), 0);
  const cantPendientes = movs.filter((m) => !m.conciliado).length;
  const cantConciliados = movs.length - cantPendientes;

  return (
    <div className="container py-6 max-w-6xl">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Conciliación MercadoPago</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Movimientos MP del local. La conciliación completa con facturas/gastos vive en PASE.
        </p>
      </header>

      {/* Filtros */}
      <Card className="mb-4">
        <CardContent className="p-4 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="h-9 w-36" />
            <span className="text-muted-foreground">→</span>
            <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="h-9 w-36" />
          </div>
          <div className="flex gap-1 ml-auto">
            {(['todos','conciliado','pendiente'] as FiltroConciliado[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFiltro(f)}
                className={cn(
                  'px-3 h-9 rounded-md border text-xs font-medium capitalize',
                  filtro === f ? 'bg-primary text-primary-foreground border-primary' : 'border-border bg-background',
                )}
              >
                {f === 'todos' ? 'Todos' : f === 'conciliado' ? '✓ Conciliados' : '⏳ Pendientes'}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Card><CardContent className="p-4">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Ingresos MP</div>
          <div className="text-lg font-bold tabular-nums text-success">{formatARS(totalIngresos)}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Egresos MP</div>
          <div className="text-lg font-bold tabular-nums text-destructive">{formatARS(totalEgresos)}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Conciliados</div>
          <div className="text-lg font-bold tabular-nums">{cantConciliados}</div>
        </CardContent></Card>
        <Card className={cn(cantPendientes > 0 && 'border-warning')}><CardContent className="p-4">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Pendientes</div>
          <div className={cn('text-lg font-bold tabular-nums', cantPendientes > 0 && 'text-warning')}>{cantPendientes}</div>
        </CardContent></Card>
      </div>

      {/* Lista */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="py-12 text-center text-muted-foreground">Cargando…</div>
          ) : movs.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground italic">
              Sin movimientos MP en el rango.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs text-muted-foreground uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-2">Fecha</th>
                  <th className="text-left px-4 py-2">Tipo</th>
                  <th className="text-left px-4 py-2">Descripción</th>
                  <th className="text-left px-4 py-2">Medio</th>
                  <th className="text-right px-4 py-2">Monto</th>
                  <th className="text-center px-4 py-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                {movs.map((m) => (
                  <tr key={m.id} className="border-t hover:bg-muted/20">
                    <td className="px-4 py-2.5 text-xs">
                      <div>{formatFechaAR(m.fecha)}</div>
                      <div className="text-muted-foreground">{formatHoraAR(m.fecha)}</div>
                    </td>
                    <td className="px-4 py-2.5 text-xs capitalize">{m.tipo}</td>
                    <td className="px-4 py-2.5 text-xs max-w-xs truncate" title={m.descripcion ?? ''}>
                      {m.descripcion ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs capitalize">{m.medio_pago ?? '—'}</td>
                    <td className={cn(
                      'px-4 py-2.5 text-right tabular-nums font-medium',
                      Number(m.monto) > 0 ? 'text-success' : 'text-destructive',
                    )}>
                      {Number(m.monto) > 0 ? '+' : ''}{formatARS(m.monto)}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {m.conciliado ? (
                        <Badge variant="green">
                          <CheckCircle2 className="h-3 w-3 mr-0.5 inline" />
                          {m.vinculo_tipo ?? 'OK'}
                        </Badge>
                      ) : (
                        <Badge variant="amber">
                          <XCircle className="h-3 w-3 mr-0.5 inline" />
                          Pendiente
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center mt-4">
        Para conciliar movimientos pendientes con facturas / gastos, andá a PASE → Conciliación MP.
        Esta vista es solo de lectura. <ExternalLink className="h-3 w-3 inline" />
      </p>
    </div>
  );
}
