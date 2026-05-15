import { useEffect, useState, useCallback } from 'react';
import { ArrowUpFromLine, ArrowDownToLine, AlertTriangle, DollarSign, Calendar } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/Badge';
import { Input } from '@/components/ui/input';
import { formatARS, formatFechaAR, formatHoraAR } from '@/lib/format';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { cn } from '@/lib/utils';

// Caja chica — vista acumulada de movimientos NO-venta del local.
// Retiros, depósitos y ajustes a lo largo de todos los turnos. Útil para:
// - Trackear pagos chicos a proveedores hechos directo de caja
// - Ver depósitos de propinas / refuerzos
// - Auditoría rápida de ajustes
//
// Default: últimos 30 días. Filtros: tipo + rango fechas.

interface Movimiento {
  id: number;
  created_at: string;
  turno_caja_id: number;
  empleado_id: string;
  tipo: 'retiro' | 'deposito' | 'ajuste' | 'apertura' | 'venta' | 'venta_anulada' | 'cierre';
  monto: number;
  metodo: string;
  motivo: string | null;
  empleado_nombre?: string | null;
}

type FiltroTipo = 'todos' | 'retiro' | 'deposito' | 'ajuste';

const HOY = new Date();
const HACE_30 = new Date(HOY.getTime() - 30 * 24 * 60 * 60 * 1000);

const tipoLabel: Record<string, { label: string; color: 'red' | 'green' | 'amber' | 'gray' | 'violet' }> = {
  retiro:        { label: 'Retiro',        color: 'red' },
  deposito:      { label: 'Depósito',      color: 'green' },
  ajuste:        { label: 'Ajuste',        color: 'amber' },
  apertura:      { label: 'Apertura',      color: 'gray' },
  cierre:        { label: 'Cierre',        color: 'gray' },
  venta_anulada: { label: 'Reverso',       color: 'violet' },
};

function tipoBadge(t: string) {
  const cfg = tipoLabel[t];
  if (!cfg) return <Badge variant="gray">{t}</Badge>;
  return <Badge variant={cfg.color as 'red' | 'green' | 'amber' | 'gray'}>{cfg.label}</Badge>;
}

export function CajaChica() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [movs, setMovs] = useState<Movimiento[]>([]);
  const [loading, setLoading] = useState(true);
  const [tipoFiltro, setTipoFiltro] = useState<FiltroTipo>('todos');
  const [desde, setDesde] = useState(HACE_30.toISOString().slice(0, 10));
  const [hasta, setHasta] = useState(HOY.toISOString().slice(0, 10));

  const reload = useCallback(async () => {
    if (!localId) return;
    setLoading(true);
    const desdeIso = new Date(desde + 'T00:00:00').toISOString();
    const hastaIso = new Date(hasta + 'T23:59:59').toISOString();

    // Tipos no-venta (excluimos 'venta' que ensucia)
    const tiposNoVenta = ['retiro', 'deposito', 'ajuste', 'venta_anulada'];
    const tiposQuery = tipoFiltro === 'todos' ? tiposNoVenta : [tipoFiltro];

    const { data } = await db.from('movimientos_caja')
      .select(`
        id, created_at, turno_caja_id, empleado_id, tipo, monto, metodo, motivo,
        empleado:rrhh_empleados!movimientos_caja_empleado_id_fkey(nombre, apellido)
      `)
      .eq('local_id', localId)
      .gte('created_at', desdeIso)
      .lte('created_at', hastaIso)
      .in('tipo', tiposQuery)
      .order('created_at', { ascending: false })
      .limit(500);

    const mapped: Movimiento[] = (data ?? []).map((r) => {
      const row = r as unknown as Movimiento & {
        empleado?: { nombre: string | null; apellido: string | null }[] | { nombre: string | null; apellido: string | null } | null;
      };
      const empData = Array.isArray(row.empleado) ? row.empleado[0] : row.empleado;
      return {
        ...row,
        empleado_nombre: empData ? [empData.apellido, empData.nombre].filter(Boolean).join(' ') : null,
      } as Movimiento;
    });
    setMovs(mapped);
    setLoading(false);
  }, [localId, tipoFiltro, desde, hasta]);

  useEffect(() => { reload(); }, [reload]);

  useRealtimeTable({
    table: 'movimientos_caja',
    onChange: () => reload(),
    scopeByLocal: true,
    debounceMs: 2000,
    enabled: !!localId,
  });

  // Stats
  const totalRetiros = movs.filter((m) => m.tipo === 'retiro').reduce((s, m) => s + Math.abs(Number(m.monto)), 0);
  const totalDepositos = movs.filter((m) => m.tipo === 'deposito').reduce((s, m) => s + Number(m.monto), 0);
  const totalAjustes = movs.filter((m) => m.tipo === 'ajuste').reduce((s, m) => s + Number(m.monto), 0);
  const totalReversos = movs.filter((m) => m.tipo === 'venta_anulada').reduce((s, m) => s + Math.abs(Number(m.monto)), 0);

  return (
    <div className="container py-6 max-w-6xl">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Caja chica</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Movimientos no-venta del local. Retiros, depósitos, ajustes y reversos acumulados.
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
            {(['todos','retiro','deposito','ajuste'] as FiltroTipo[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTipoFiltro(t)}
                className={cn(
                  'px-3 h-9 rounded-md border text-xs font-medium capitalize',
                  tipoFiltro === t ? 'bg-primary text-primary-foreground border-primary' : 'border-border bg-background',
                )}
              >
                {t === 'todos' ? 'Todos' : t === 'retiro' ? 'Retiros' : t === 'deposito' ? 'Depósitos' : 'Ajustes'}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <StatCard icon={ArrowUpFromLine} label="Retiros" valor={formatARS(totalRetiros)} color="text-destructive" />
        <StatCard icon={ArrowDownToLine} label="Depósitos" valor={formatARS(totalDepositos)} color="text-success" />
        <StatCard icon={AlertTriangle} label="Ajustes netos" valor={formatARS(totalAjustes)} color="text-warning" />
        <StatCard icon={DollarSign} label="Reversos" valor={formatARS(totalReversos)} color="text-violet-600" />
      </div>

      {/* Tabla */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-12 text-center text-muted-foreground">Cargando…</div>
          ) : movs.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground italic">
              Sin movimientos en el rango.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs text-muted-foreground uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-2">Fecha</th>
                  <th className="text-left px-4 py-2">Tipo</th>
                  <th className="text-left px-4 py-2">Empleado</th>
                  <th className="text-left px-4 py-2">Método</th>
                  <th className="text-right px-4 py-2">Monto</th>
                  <th className="text-left px-4 py-2">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {movs.map((m) => (
                  <tr key={m.id} className="border-t hover:bg-muted/20">
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      <div>{formatFechaAR(m.created_at)}</div>
                      <div className="text-[10px]">{formatHoraAR(m.created_at)}</div>
                    </td>
                    <td className="px-4 py-2.5">{tipoBadge(m.tipo)}</td>
                    <td className="px-4 py-2.5 text-xs">{m.empleado_nombre ?? '—'}</td>
                    <td className="px-4 py-2.5 text-xs capitalize">{m.metodo}</td>
                    <td className={cn(
                      'px-4 py-2.5 text-right tabular-nums font-medium',
                      m.tipo === 'retiro' || m.tipo === 'venta_anulada' ? 'text-destructive' :
                      m.tipo === 'deposito' ? 'text-success' : '',
                    )}>
                      {Number(m.monto) > 0 ? '+' : ''}{formatARS(m.monto)}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-xs">
                      {m.motivo ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface StatCardProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  valor: string;
  color: string;
}

function StatCard({ icon: Icon, label, valor, color }: StatCardProps) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <Icon className={cn('h-5 w-5 flex-shrink-0', color)} />
        <div className="min-w-0">
          <div className="text-[10px] uppercase text-muted-foreground tracking-wide">{label}</div>
          <div className="text-lg font-bold tabular-nums">{valor}</div>
        </div>
      </CardContent>
    </Card>
  );
}
