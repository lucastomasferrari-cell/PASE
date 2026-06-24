import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { listVentas } from '@/services/ventasService';
import { useVisiblePolling } from '@/lib/useVisiblePolling';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import type { VentaPos, ModoVenta } from '@/types/database';
import { formatARS, relativoCorto } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Props {
  modos?: ModoVenta[];
}

// Rail horizontal estilo "comandero físico" — barra de metal con tickets
// colgando uno al lado del otro, scroll horizontal cuando hay muchos.
export function ComandasRail({ modos }: Props) {
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

  useEffect(() => { reload(); }, [reload]);
  useVisiblePolling(reload, 90_000);
  useRealtimeTable({ table: 'ventas_pos', onChange: reload, scopeByLocal: true });

  return (
    <div className="shrink-0 border-b border-border bg-card">
      {/* ── Barra de metal ─────────────────────────────────────────────── */}
      <div
        className="flex items-center px-4 gap-3 select-none"
        style={{
          height: 28,
          background: 'linear-gradient(to bottom, #52525b, #3f3f46, #27272a)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.4)',
        }}
      >
        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
          Comandas activas
        </span>
        {!loading && (
          <span
            className="text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(255,255,255,0.08)', color: '#a1a1aa' }}
          >
            {ventas.length}
          </span>
        )}
        {/* Rieles / tornillos decorativos */}
        <div className="flex-1 flex items-center gap-6 ml-2">
          {[...Array(12)].map((_, i) => (
            <div
              key={i}
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{
                background: 'radial-gradient(circle at 35% 35%, #71717a, #27272a)',
                boxShadow: '0 1px 2px rgba(0,0,0,0.5)',
              }}
            />
          ))}
        </div>
      </div>

      {/* ── Tickets ────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="h-[104px] flex items-center px-4">
          <span className="text-xs text-muted-foreground">Cargando…</span>
        </div>
      ) : ventas.length === 0 ? (
        <div className="h-[72px] flex items-center justify-center">
          <span className="text-xs text-muted-foreground">Sin comandas activas</span>
        </div>
      ) : (
        <div
          className="flex items-start gap-2 overflow-x-auto px-3 py-2"
          style={{ scrollbarWidth: 'thin' }}
        >
          {ventas.map((v) => (
            <Ticket key={v.id} venta={v} />
          ))}
        </div>
      )}
    </div>
  );
}

function Ticket({ venta: v }: { venta: VentaPos }) {
  const minAbierta = Math.floor((Date.now() - new Date(v.abierta_at).getTime()) / 60000);
  const urgente = minAbierta > 60;
  const atencion = minAbierta > 30 && !urgente;

  const ubicacion =
    v.modo === 'salon' && v.mesa_id
      ? `Mesa ${v.mesa_id}`
      : ((v as VentaPos & { tab_nombre?: string }).tab_nombre ?? v.cliente_nombre ?? 'Sin nombre');

  return (
    <Link
      to={`/pos/venta/${v.id}`}
      className={cn(
        'relative flex-shrink-0 rounded border-2 bg-card hover:bg-accent transition-colors overflow-visible',
        'flex flex-col items-center pt-3 pb-2 px-2 gap-0.5 text-center',
        urgente
          ? 'border-destructive/70 bg-destructive/5'
          : atencion
            ? 'border-warning/60 bg-warning/5'
            : 'border-border/80',
      )}
      style={{ width: 108, minHeight: 100 }}
    >
      {/* Clip — cuelga del riel */}
      <span
        className="absolute -top-[7px] left-1/2 -translate-x-1/2 w-5 h-[7px] rounded-t-sm block"
        style={{
          background: 'linear-gradient(to bottom, #71717a, #52525b)',
          boxShadow: '0 -1px 0 rgba(255,255,255,0.1)',
        }}
      />

      {/* Número de comanda */}
      <div className="text-base font-black leading-none tracking-tight">
        #{v.numero_local}
      </div>

      {/* Mesa o cliente */}
      <div className="text-[10px] text-muted-foreground truncate max-w-full leading-tight">
        {ubicacion}
      </div>

      {/* Tiempo — color según urgencia */}
      <div
        className={cn(
          'text-xs font-semibold tabular-nums leading-tight mt-0.5',
          urgente
            ? 'text-destructive animate-pulse'
            : atencion
              ? 'text-warning'
              : 'text-muted-foreground',
        )}
      >
        {relativoCorto(v.abierta_at)}
      </div>

      {/* Total */}
      <div className="text-xs font-bold tabular-nums leading-tight">
        {formatARS(v.total)}
      </div>

      {/* Estado */}
      <div
        className={cn(
          'mt-1 text-[9px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5',
          v.estado === 'lista'
            ? 'bg-success/15 text-success'
            : v.estado === 'enviada'
              ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
              : v.estado === 'entregada'
                ? 'bg-muted text-muted-foreground'
                : 'bg-muted/50 text-muted-foreground',
        )}
      >
        {v.estado === 'lista' ? '✓ lista'
          : v.estado === 'enviada' ? 'cocina'
            : v.estado === 'entregada' ? 'entregada'
              : 'abierta'}
      </div>
    </Link>
  );
}
