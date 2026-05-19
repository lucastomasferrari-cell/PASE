import { useCallback, useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { Check } from 'lucide-react';
import { getPedidoPublico, type PedidoPublicoEstado } from '@/services/tiendaService';
import { useVisiblePolling } from '@/lib/useVisiblePolling';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatARS } from '@/lib/format';
import type { TiendaCtx } from './TiendaLayout';
import { EstadoPedidoTimeline, PASOS_DELIVERY, PASOS_RETIRO } from './components/EstadoPedidoTimeline';

const POLL_MS = 15000;

export function TiendaConfirmacion() {
  const { local } = useOutletContext<TiendaCtx>();
  const { ventaId } = useParams<{ ventaId: string }>();
  const id = ventaId ? Number(ventaId) : 0;
  const [estado, setEstado] = useState<PedidoPublicoEstado | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const telefono = sessionStorage.getItem(`comanda-tel-${id}`) ?? '';

  const tick = useCallback(async () => {
    if (!id || !telefono) return;
    const { data } = await getPedidoPublico(id, telefono);
    if (!data) setNotFound(true); else setEstado(data);
    setLoading(false);
  }, [id, telefono]);

  // Sprint 7 PERF: useVisiblePolling pausa cuando la pestaña se oculta.
  useEffect(() => {
    if (!id || !telefono) { setLoading(false); setNotFound(true); return; }
    void tick();
  }, [id, telefono, tick]);
  useVisiblePolling(tick, POLL_MS);

  if (loading) {
    return (
      <div className="max-w-md mx-auto px-5 py-12">
        <div className="text-center space-y-3 mb-8">
          <Skeleton className="h-16 w-16 rounded-full mx-auto" />
          <Skeleton className="h-6 w-48 mx-auto" />
          <Skeleton className="h-4 w-32 mx-auto" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-md" />)}
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="max-w-md mx-auto p-12 text-center">
        <div className="text-4xl mb-3">🤔</div>
        <h2 className="text-xl font-medium">No encontramos tu pedido</h2>
        <p className="text-sm text-foreground/60 mt-3">
          Probá desde "Mi pedido" en el header con tu número de teléfono.
        </p>
        <Link to={`/tienda/${local.slug}/seguimiento`} className="inline-block mt-6 text-sm underline text-primary">
          Buscar mi pedido
        </Link>
      </div>
    );
  }
  if (!estado) return null;

  const rechazada = estado.estado === 'anulada';
  const pasos = estado.tipo_entrega === 'delivery' ? PASOS_DELIVERY : PASOS_RETIRO;
  const tiempoEstimado = estado.tipo_entrega === 'delivery'
    ? local.tiempo_delivery_min
    : local.tiempo_retiro_min;
  const labelPago = estado.tipo_entrega === 'delivery' ? 'Pago al recibir' : 'Pagás al retirar';

  return (
    <div className="max-w-md mx-auto px-5 py-8 sm:py-12">
      {/* Hero éxito */}
      <div className="text-center mb-10">
        <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-primary text-primary-foreground mb-5">
          <Check className="h-8 w-8" strokeWidth={3} />
        </div>
        <h1 className="text-2xl font-medium">¡Pedido recibido!</h1>
        <p className="text-sm text-foreground/60 mt-1.5">Pedido #{estado.numero_local}</p>
      </div>

      {/* Info clave */}
      {!rechazada && (
        <div className="rounded-xl bg-gray-50 p-5 mb-8 space-y-2 text-sm">
          {tiempoEstimado > 0 && (
            <div className="flex justify-between">
              <span className="text-foreground/60">Tiempo estimado</span>
              <span className="font-medium">{tiempoEstimado} min</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-foreground/60">Pago</span>
            <span className="font-medium">{labelPago}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-foreground/60">Total</span>
            <span className="font-medium">{formatARS(estado.total)}</span>
          </div>
          {estado.programada_para && (
            <div className="flex justify-between border-t border-gray-100 pt-2 mt-1">
              <span className="text-foreground/60">📅 Programado para</span>
              <span className="font-medium">
                {new Date(estado.programada_para).toLocaleString('es-AR', {
                  weekday: 'short',
                  day: '2-digit',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Estado */}
      {rechazada ? (
        <div className="rounded-md border border-destructive bg-destructive/5 p-5 text-center mb-8">
          <p className="text-sm font-medium text-destructive">Tu pedido fue cancelado</p>
          {estado.rechazo_motivo && (
            <p className="text-xs text-foreground/70 mt-2">"{estado.rechazo_motivo}"</p>
          )}
          <p className="text-xs text-foreground/60 mt-3">
            Comunicate con el local: {local.telefono ?? '(sin teléfono)'}
          </p>
        </div>
      ) : (
        <>
          <div className="text-xs uppercase tracking-wide text-foreground/60 mb-4">
            Estado del pedido
          </div>
          <EstadoPedidoTimeline pasos={pasos} estadoActual={estado.estado} />
        </>
      )}

      <Link to={`/tienda/${local.slug}`} className="block mt-8">
        <Button variant="outline" className="w-full h-12 text-base">
          Hacer otro pedido
        </Button>
      </Link>
    </div>
  );
}
