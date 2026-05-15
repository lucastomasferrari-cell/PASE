import { useEffect, useState, useCallback } from 'react';
import { Users, Clock, MapPin, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { db } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/Badge';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { formatHoraAR } from '@/lib/format';
import { cn } from '@/lib/utils';

// Empleados trabajando ahora — dashboard simple para dueño multi-local.
// Muestra:
//   - Turnos abiertos en cada local del tenant (con tiempo abierto)
//   - Cajero del turno (nombre)
//   - Cantidad de ventas del turno
//   - Total efectivo del turno
//
// Útil para: "¿qué está pasando en mis locales en este momento?"
//
// Stub /empleados/horarios actualmente apunta acá hasta que se construya
// el módulo completo de horarios + rotaciones.

interface TurnoActivo {
  id: number;
  local_id: number;
  local_nombre: string | null;
  numero: number;
  abierto_at: string;
  cajero_id: string;
  cajero_nombre: string | null;
  monto_inicial: number;
}

export function EmpleadosTrabajando() {
  const { user } = useAuth();
  const [turnos, setTurnos] = useState<TurnoActivo[]>([]);
  const [stats, setStats] = useState<Record<number, { ventas: number; efectivo: number }>>({});
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!user?.tenant_id) return;
    setLoading(true);
    // Turnos abiertos del tenant (todos los locales accesibles)
    // eslint-disable-next-line pase-local/require-apply-local-scope -- dashboard multi-local intencional: dueño/admin ven todos los locales
    const { data: ts } = await db.from('turnos_caja')
      .select(`
        id, local_id, numero, abierto_at, cajero_id, monto_inicial,
        local:locales(nombre),
        cajero:rrhh_empleados!turnos_caja_cajero_id_fkey(nombre, apellido)
      `)
      .eq('tenant_id', user.tenant_id)
      .eq('estado', 'abierto')
      .order('abierto_at', { ascending: true });

    const mapped: TurnoActivo[] = (ts ?? []).map((r) => {
      const row = r as unknown as TurnoActivo & {
        local?: { nombre: string | null } | { nombre: string | null }[] | null;
        cajero?: { nombre: string | null; apellido: string | null } | { nombre: string | null; apellido: string | null }[] | null;
      };
      const local = Array.isArray(row.local) ? row.local[0] : row.local;
      const cajero = Array.isArray(row.cajero) ? row.cajero[0] : row.cajero;
      return {
        id: row.id,
        local_id: row.local_id,
        local_nombre: local?.nombre ?? null,
        numero: row.numero,
        abierto_at: row.abierto_at,
        cajero_id: row.cajero_id,
        cajero_nombre: cajero ? [cajero.apellido, cajero.nombre].filter(Boolean).join(' ') : null,
        monto_inicial: row.monto_inicial,
      };
    });
    setTurnos(mapped);

    // Stats por turno: cantidad de ventas cobradas + total efectivo (apertura + ventas efectivo - retiros + depositos)
    const turnoIds = mapped.map((t) => t.id);
    if (turnoIds.length > 0) {
      // eslint-disable-next-line pase-local/require-apply-local-scope -- IN(turnoIds) ya filtra implícito por locales accesibles del dashboard multi-local
      const { data: movs } = await db.from('movimientos_caja')
        .select('turno_caja_id, tipo, monto, metodo')
        .in('turno_caja_id', turnoIds);
      const stats: Record<number, { ventas: number; efectivo: number }> = {};
      for (const t of mapped) stats[t.id] = { ventas: 0, efectivo: 0 };
      for (const m of (movs ?? []) as Array<{ turno_caja_id: number; tipo: string; monto: number; metodo: string }>) {
        const s = stats[m.turno_caja_id];
        if (!s) continue;
        if (m.tipo === 'venta') s.ventas += 1;
        if (m.metodo === 'efectivo') {
          if (['apertura','venta','deposito','ajuste'].includes(m.tipo)) s.efectivo += Number(m.monto);
          else if (['retiro','venta_anulada'].includes(m.tipo)) s.efectivo -= Math.abs(Number(m.monto));
        }
      }
      setStats(stats);
    }
    setLoading(false);
  }, [user?.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  useRealtimeTable({ table: 'turnos_caja', onChange: () => reload() });

  return (
    <div className="container py-6 max-w-4xl">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Users className="h-6 w-6" />
          Trabajando ahora
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Cajeros con turno abierto en cada local. Se actualiza en vivo.
        </p>
      </header>

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">Cargando…</div>
      ) : turnos.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
              <AlertCircle className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-1">Ningún turno abierto</h3>
            <p className="text-sm text-muted-foreground">
              Nadie está cobrando en este momento en ningún local del tenant.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {turnos.map((t) => {
            const ahora = Date.now();
            const desde = new Date(t.abierto_at).getTime();
            const minutos = Math.floor((ahora - desde) / 60000);
            const horas = Math.floor(minutos / 60);
            const mins = minutos % 60;
            const tiempoStr = horas > 0 ? `${horas}h ${mins}m` : `${mins}m`;
            const s = stats[t.id] ?? { ventas: 0, efectivo: 0 };

            return (
              <Card key={t.id} className="overflow-hidden">
                <CardContent className="p-0">
                  <div className="px-4 py-3 border-b bg-success/5 flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="inline-flex items-center justify-center h-10 w-10 rounded-full bg-success/20">
                        <CheckCircle2 className="h-5 w-5 text-success" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">{t.cajero_nombre ?? `Cajero ${t.cajero_id.slice(0,8)}…`}</div>
                        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <MapPin className="h-3 w-3" />
                          {t.local_nombre ?? `Local ${t.local_id}`}
                        </div>
                      </div>
                    </div>
                    <Badge variant="green">Turno #{t.numero} abierto</Badge>
                  </div>
                  <div className="px-4 py-3 grid grid-cols-3 gap-3 text-sm">
                    <Stat
                      icon={Clock}
                      label="Tiempo abierto"
                      valor={tiempoStr}
                      sub={formatHoraAR(t.abierto_at)}
                    />
                    <Stat
                      label="Ventas cobradas"
                      valor={String(s.ventas)}
                      sub={s.ventas === 1 ? '1 venta' : `${s.ventas} ventas`}
                    />
                    <Stat
                      label="Efectivo en caja"
                      valor={`$${s.efectivo.toLocaleString('es-AR')}`}
                      sub={`apertura $${Number(t.monto_inicial).toLocaleString('es-AR')}`}
                    />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface StatProps { icon?: React.ComponentType<{ className?: string }>; label: string; valor: string; sub?: string }
function Stat({ icon: Icon, label, valor, sub }: StatProps) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground uppercase tracking-wide flex items-center gap-1">
        {Icon && <Icon className={cn('h-3 w-3')} />}
        {label}
      </div>
      <div className="text-base font-semibold tabular-nums">{valor}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
