import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { Check, Clock, ChefHat, Package } from 'lucide-react';
import { getPedidoPublico, type PedidoPublicoEstado } from '@/services/tiendaService';
import { Button } from '@/components/ui/button';
import { formatARS } from '@/lib/format';
import type { TiendaCtx } from './TiendaLayout';

const POLL_MS = 15000;

const PASOS = [
  { key: 'necesita_aprobacion', label: 'Esperando aprobación', icon: Clock },
  { key: 'enviada',             label: 'En cocina',            icon: ChefHat },
  { key: 'lista',               label: 'Lista para retirar',   icon: Package },
  { key: 'entregada',           label: 'Entregada',            icon: Check },
];

export function TiendaConfirmacion() {
  const { local } = useOutletContext<TiendaCtx>();
  const { ventaId } = useParams<{ ventaId: string }>();
  const id = ventaId ? Number(ventaId) : 0;
  const [estado, setEstado] = useState<PedidoPublicoEstado | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const telefono = sessionStorage.getItem(`comanda-tel-${id}`) ?? '';

  useEffect(() => {
    if (!id || !telefono) { setLoading(false); setNotFound(true); return; }
    let cancelled = false;
    async function tick() {
      const { data } = await getPedidoPublico(id, telefono);
      if (cancelled) return;
      if (!data) setNotFound(true); else setEstado(data);
      setLoading(false);
    }
    tick();
    const interval = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [id, telefono]);

  if (loading) return <div className="p-6 text-center text-sm text-muted-foreground">Cargando…</div>;
  if (notFound) {
    return (
      <div className="max-w-md mx-auto p-6 text-center">
        <div className="text-4xl mb-3">🤔</div>
        <h2 className="font-semibold">No encontramos tu pedido</h2>
        <p className="text-sm text-muted-foreground mt-2">Probá desde "Mi pedido" en el header.</p>
        <Link to={`/tienda/${local.slug}/seguimiento`} className="text-sm underline text-primary mt-4 inline-block">Buscar mi pedido</Link>
      </div>
    );
  }
  if (!estado) return null;

  const pasoActualIdx = PASOS.findIndex(p => p.key === estado.estado);
  const labelEntrega = estado.tipo_entrega === 'delivery' ? 'Camino a tu dirección' : 'Listo para retirar';
  const tiempoEstimado = estado.tipo_entrega === 'delivery'
    ? local.tiempo_delivery_min : local.tiempo_retiro_min;
  const rechazada = estado.estado === 'anulada';

  return (
    <div className="max-w-md mx-auto p-4">
      <div className="text-center py-6">
        <div className="text-5xl mb-2">🎉</div>
        <h1 className="text-xl font-semibold">Pedido recibido</h1>
        <p className="text-sm text-muted-foreground">N° {estado.numero_local} · {formatARS(estado.total)}</p>
        {tiempoEstimado > 0 && !rechazada && (
          <p className="text-xs text-muted-foreground mt-1">Tiempo estimado: {tiempoEstimado} min</p>
        )}
      </div>

      {rechazada ? (
        <div className="rounded-md border border-destructive bg-destructive/5 p-4 text-center">
          <p className="text-sm font-medium text-destructive">Tu pedido fue cancelado</p>
          <p className="text-xs text-muted-foreground mt-2">Comunicate con el local: {local.telefono ?? '(sin teléfono)'}</p>
        </div>
      ) : (
        <div className="space-y-3 my-4">
          {PASOS.map((p, idx) => {
            const Icon = p.icon;
            const realLabel = p.key === 'lista' ? labelEntrega : p.label;
            const completado = pasoActualIdx >= idx;
            const enCurso = pasoActualIdx === idx;
            return (
              <div
                key={p.key}
                className={`flex items-center gap-3 p-3 rounded-md border ${
                  enCurso ? 'border-primary bg-primary/5' : completado ? 'border-border bg-muted/30' : 'border-border'
                }`}
              >
                <div className={`h-9 w-9 rounded-full flex items-center justify-center ${
                  completado ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                }`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1">
                  <div className={`text-sm ${enCurso ? 'font-semibold' : 'font-medium'}`}>{realLabel}</div>
                  {enCurso && <div className="text-[10px] text-muted-foreground">Estado actual</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Link to={`/tienda/${local.slug}`} className="block">
        <Button variant="outline" className="w-full">Hacer otro pedido</Button>
      </Link>
    </div>
  );
}
