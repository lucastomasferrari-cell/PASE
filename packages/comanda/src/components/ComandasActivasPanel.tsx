import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { listVentas } from '@/services/ventasService';
import { useVisiblePolling } from '@/lib/useVisiblePolling';
import type { VentaPos, ModoVenta } from '@/types/database';
import { formatARS, relativoCorto } from '@/lib/format';
import { Badge } from '@/components/Badge';
import { cn } from '@/lib/utils';

interface Props {
  className?: string;
  modos?: ModoVenta[]; // filtra por modo (ej. solo 'salon' en SalonView)
}

// Panel izquierdo de SalonView/MostradorView. Lista comandas activas
// (estados abierta/enviada/lista/entregada) ordenadas por tiempo abierta
// — más viejas arriba para urgencia visual. Click navega a la venta.
// Refresca cada 15s para mostrar tiempos relativos actualizados.
export function ComandasActivasPanel({ className, modos }: Props) {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [ventas, setVentas] = useState<VentaPos[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (localId === null) return;
    const { data } = await listVentas({
      localId,
      modos,
      estados: ['abierta', 'enviada', 'lista', 'entregada'],
    });
    setVentas(data);
    setLoading(false);
  }, [localId, modos]);

  // Sprint 7 PERF: useVisiblePolling pausa cuando la pestaña esta oculta.
  useEffect(() => { reload(); }, [reload]);
  useVisiblePolling(reload, 15_000);

  return (
    <aside className={cn('bg-card flex flex-col', className)}>
      <header className="px-4 py-3 border-b border-border flex-shrink-0">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Comandas activas ({ventas.length})
        </h2>
      </header>
      {loading ? (
        <div className="p-4 text-center text-sm text-muted-foreground">Cargando…</div>
      ) : ventas.length === 0 ? (
        <div className="p-6 text-center">
          <Inbox className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Sin comandas abiertas.</p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto divide-y divide-border">
          {ventas.map((v) => (
            <li key={v.id}>
              <Link
                to={`/pos/venta/${v.id}`}
                className="block px-4 py-3 hover:bg-accent transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-sm">#{v.numero_local}</strong>
                  <Badge variant={estadoColor(v.estado)}>{v.estado}</Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1 truncate">
                  {v.modo === 'salon' && v.mesa_id ? `Mesa ${v.mesa_id}` : (v.cliente_nombre ?? 'Sin nombre')}
                </div>
                <div className="flex items-center justify-between mt-1.5">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {relativoCorto(v.abierta_at)}
                  </span>
                  <span className="text-sm font-medium tabular-nums">
                    {formatARS(v.total)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function estadoColor(e: string): 'gray' | 'amber' | 'blue' | 'green' {
  if (e === 'abierta') return 'gray';
  if (e === 'enviada') return 'amber';
  if (e === 'lista') return 'blue';
  if (e === 'entregada') return 'green';
  return 'gray';
}
