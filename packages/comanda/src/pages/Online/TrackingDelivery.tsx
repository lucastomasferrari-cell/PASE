import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Truck, Clock, ChefHat, CheckCircle2, Package, MapPin } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/Badge';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { formatHoraAR } from '@/lib/format';
import { cn } from '@/lib/utils';

// Tracking delivery — pedidos modo='pedidos' tipo_entrega='delivery' en
// estado activo (no cobrado/anulado/entregado). Útil para que el dueño
// vea quién está esperando comida y hace cuánto.

interface PedidoTracking {
  id: number;
  numero_local: number;
  estado: string;
  cliente_nombre: string | null;
  cliente_telefono: string | null;
  cliente_direccion: string | null;
  abierta_at: string;
  total: number;
  programada_para: string | null;
}

const ESTADOS_ACTIVOS = ['necesita_aprobacion', 'programada', 'abierta', 'enviada', 'lista'];

const STEPS = [
  { key: 'necesita_aprobacion', label: 'Por aprobar', icon: Clock },
  { key: 'abierta',              label: 'Aceptado',   icon: CheckCircle2 },
  { key: 'enviada',              label: 'En cocina',  icon: ChefHat },
  { key: 'lista',                label: 'Listo',      icon: Package },
] as const;

function indiceEstado(estado: string): number {
  const idx = STEPS.findIndex((s) => s.key === estado);
  return idx >= 0 ? idx : -1;
}

export function TrackingDelivery() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();
  const [pedidos, setPedidos] = useState<PedidoTracking[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!localId) return;
    setLoading(true);
    const { data } = await db.from('ventas_pos')
      .select('id, numero_local, estado, cliente_nombre, cliente_telefono, cliente_direccion, abierta_at, total, programada_para')
      .eq('local_id', localId)
      .eq('modo', 'pedidos')
      .eq('tipo_entrega', 'delivery')
      .in('estado', ESTADOS_ACTIVOS)
      .is('deleted_at', null)
      .order('abierta_at', { ascending: true });
    setPedidos((data ?? []) as PedidoTracking[]);
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  useRealtimeTable({
    table: 'ventas_pos',
    onChange: () => reload(),
    scopeByLocal: true,
    extraFilter: 'modo=eq.pedidos',
    debounceMs: 2000,
    enabled: !!localId,
  });

  return (
    <div className="container py-6 max-w-5xl">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Truck className="h-6 w-6" />
          Tracking delivery
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pedidos delivery en curso. Timeline visual + tiempo transcurrido.
        </p>
      </header>

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">Cargando…</div>
      ) : pedidos.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Truck className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <h3 className="text-lg font-medium mb-1">No hay deliveries en curso</h3>
            <p className="text-sm text-muted-foreground">
              Cuando entren pedidos para envío aparecerán acá con su progreso.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {pedidos.map((p) => {
            const idxEstado = indiceEstado(p.estado);
            const ahora = Date.now();
            const desde = new Date(p.abierta_at).getTime();
            const minutos = Math.floor((ahora - desde) / 60000);
            const urgente = minutos > 45;
            const tarde = minutos > 30 && !urgente;

            return (
              <Card
                key={p.id}
                className={cn(
                  'overflow-hidden cursor-pointer hover:border-primary/50 transition-colors',
                  urgente && 'border-destructive/40',
                  tarde && 'border-warning/40',
                )}
                onClick={() => navigate(`/pos/pedidos/${p.id}`)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="text-base font-bold tabular-nums">#{p.numero_local}</div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{p.cliente_nombre ?? 'Sin nombre'}</div>
                        <div className="text-xs text-muted-foreground">{p.cliente_telefono ?? ''}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={urgente ? 'red' : tarde ? 'amber' : 'gray'}>
                        Hace {minutos < 60 ? `${minutos} min` : `${Math.floor(minutos/60)}h ${minutos%60}m`}
                      </Badge>
                      {p.programada_para && (
                        <Badge variant="violet">
                          Programado {new Date(p.programada_para).toLocaleString('es-AR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {p.cliente_direccion && (
                    <div className="flex items-start gap-1.5 text-xs text-muted-foreground mb-3">
                      <MapPin className="h-3 w-3 mt-0.5" />
                      {p.cliente_direccion}
                    </div>
                  )}

                  {/* Timeline visual */}
                  <div className="flex items-center gap-1">
                    {STEPS.map((s, i) => {
                      const completado = i <= idxEstado;
                      const actual = i === idxEstado;
                      const Icon = s.icon;
                      return (
                        <div key={s.key} className="flex items-center flex-1">
                          <div className={cn(
                            'inline-flex items-center justify-center h-8 w-8 rounded-full border-2 flex-shrink-0',
                            completado ? 'bg-success border-success text-white' : 'border-border text-muted-foreground',
                            actual && 'ring-2 ring-success/30',
                          )}>
                            <Icon className="h-3.5 w-3.5" />
                          </div>
                          {i < STEPS.length - 1 && (
                            <div className={cn(
                              'flex-1 h-0.5 mx-1',
                              completado ? 'bg-success' : 'bg-border',
                            )} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex justify-between mt-1 text-[10px] text-muted-foreground">
                    {STEPS.map((s) => <span key={s.key}>{s.label}</span>)}
                  </div>

                  <div className="mt-3 pt-2 border-t text-right">
                    <span className="text-sm font-semibold tabular-nums">${Number(p.total).toLocaleString('es-AR')}</span>
                    <span className="text-xs text-muted-foreground ml-2">abierta {formatHoraAR(p.abierta_at)}</span>
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
