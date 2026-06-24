import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { listVentas } from '@/services/ventasService';
import { useVisiblePolling } from '@/lib/useVisiblePolling';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import type { VentaPos, ModoVenta } from '@/types/database';
import { relativoCorto } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Props {
  modos?: ModoVenta[];
  /** Mapa id→nombre de mesas para mostrar "B1" en vez del ID interno */
  mesaMap?: Map<number, string>;
}

export function ComandasRail({ modos, mesaMap }: Props) {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [ventas, setVentas] = useState<VentaPos[]>([]);

  const reload = useCallback(async () => {
    if (localId === null) return;
    const { data } = await listVentas({
      localId,
      modos,
      estados: ['abierta', 'enviada', 'lista', 'entregada'],
    });
    setVentas(data);
  }, [localId, modos]);

  useEffect(() => { reload(); }, [reload]);
  useVisiblePolling(reload, 90_000);
  useRealtimeTable({ table: 'ventas_pos', onChange: reload, scopeByLocal: true });

  if (ventas.length === 0) return null;

  return (
    <div
      className="shrink-0 border-b border-border"
      style={{ background: 'var(--background)' }}
    >
      <div
        className="flex items-center gap-1 px-3 py-1.5 overflow-x-auto"
        style={{ scrollbarWidth: 'none' }}
      >
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 shrink-0 mr-1 select-none">
          Pedidos
        </span>
        {ventas.map((v) => (
          <OrderChip key={v.id} venta={v} mesaMap={mesaMap} />
        ))}
      </div>
    </div>
  );
}

function OrderChip({ venta: v, mesaMap }: { venta: VentaPos; mesaMap?: Map<number, string> }) {
  const min = Math.floor((Date.now() - new Date(v.abierta_at).getTime()) / 60000);
  const urgente = min > 60;
  const atencion = min > 30 && !urgente;

  const ubicacion =
    v.modo === 'salon' && v.mesa_id
      ? (mesaMap?.get(v.mesa_id) ?? `#${v.mesa_id}`)
      : ((v as VentaPos & { tab_nombre?: string }).tab_nombre ?? v.cliente_nombre ?? null);

  return (
    <Link
      to={`/pos/venta/${v.id}`}
      className={cn(
        'flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-colors',
        'hover:bg-accent',
        urgente
          ? 'border-destructive/50 text-destructive bg-destructive/5'
          : atencion
            ? 'border-warning/50 text-warning-foreground bg-warning/5'
            : 'border-border text-foreground',
      )}
    >
      {/* Dot de urgencia */}
      <span
        className={cn(
          'w-1.5 h-1.5 rounded-full flex-shrink-0',
          urgente ? 'bg-destructive animate-pulse' : atencion ? 'bg-warning' : 'bg-success',
        )}
      />
      <span className="font-bold tabular-nums">#{v.numero_local}</span>
      {ubicacion && (
        <span className="text-muted-foreground">{ubicacion}</span>
      )}
      <span className="text-muted-foreground/70 tabular-nums">{relativoCorto(v.abierta_at)}</span>
    </Link>
  );
}
