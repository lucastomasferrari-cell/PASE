import { Phone, MapPin, Home, MessageSquareWarning, Clock, Timer } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BadgePago } from './BadgePago';
import { UrgencyTimer } from './UrgencyTimer';
import { formatARS } from '@/lib/format';
import { calcularEstadoPago, grupoDePedido, type PedidoGrupo } from '@/services/pedidosService';
import type { Canal, EstadoVenta, VentaPos, VentaPosItem, VentaPosPago } from '@/types/database';

// Overline de estado — mismo color que el badge de la versión anterior, ahora
// como uppercase text-[10px] arriba del #N para no pisarse con el pago.
const ESTADO_OVERLINE: Record<EstadoVenta, { label: string; text: string }> = {
  abierta:             { label: 'En carga',    text: 'text-emerald-400' },
  necesita_aprobacion: { label: 'Por aceptar', text: 'text-amber-400' },
  programada:          { label: 'Programada',  text: 'text-sky-400' },
  enviada:             { label: 'En cocina',   text: 'text-emerald-400' },
  lista:               { label: 'Lista',       text: 'text-green-300' },
  en_camino:           { label: 'En camino',   text: 'text-emerald-400' },
  entregada:           { label: 'Entregada',   text: 'text-muted-foreground' },
  cobrada:             { label: 'Cobrada',     text: 'text-muted-foreground' },
  anulada:             { label: 'Anulada',     text: 'text-destructive' },
};

function overlineEstado(estado: EstadoVenta, grupo: PedidoGrupo): { label: string; text: string } {
  if (grupo === 'programadas') return ESTADO_OVERLINE.programada;
  return ESTADO_OVERLINE[estado] ?? ESTADO_OVERLINE.abierta;
}

// Cuadrado con icono/emoji del canal — reemplaza el tint completo del header.
// bg tenue + emoji del canal, o inicial como fallback.
const CANAL_SQUARE: Record<string, { bg: string; text: string }> = {
  rappi:           { bg: 'bg-red-500/15',     text: 'text-red-400' },
  'pedidos-ya':    { bg: 'bg-purple-500/15',  text: 'text-purple-400' },
  whatsapp:        { bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
  'tienda-propia': { bg: 'bg-orange-500/15', text: 'text-orange-400' },
  salon:           { bg: 'bg-amber-500/15',  text: 'text-amber-400' },
  mostrador:       { bg: 'bg-sky-500/15',    text: 'text-sky-400' },
  'menu-qr':       { bg: 'bg-pink-500/15',   text: 'text-pink-400' },
};
const CANAL_SQUARE_FALLBACK = { bg: 'bg-slate-500/15', text: 'text-slate-400' };

interface Props {
  pedido: VentaPos & { items: VentaPosItem[]; pagos?: VentaPosPago[] };
  canales: Canal[];
  variant?: 'default' | 'listo';
  onClick: () => void;
}

// Resumen de items para la card: max 2 nombres + "y N más".
function resumenItems(items: (VentaPosItem & { item?: { nombre: string | null } | null })[]): { lineas: { qty: number; nombre: string }[]; resto: number } {
  const activos = items.filter((it) => it.estado !== 'anulado');
  const top = activos.slice(0, 2);
  const lineas = top.map((it) => ({
    qty: Number(it.cantidad),
    nombre: it.item?.nombre ?? `Item #${it.item_id}`,
  }));
  return { lineas, resto: Math.max(0, activos.length - 2) };
}

export function PedidoCard({ pedido, canales, variant = 'default', onClick }: Props) {
  const canal = canales.find((c) => c.id === pedido.canal_id);
  const canalSquare = canal ? (CANAL_SQUARE[canal.slug] ?? CANAL_SQUARE_FALLBACK) : CANAL_SQUARE_FALLBACK;

  const { lineas, resto } = resumenItems(pedido.items);
  const estadoPago = calcularEstadoPago(Number(pedido.total), pedido.pagos ?? []);
  const aclaracion = pedido.notas?.trim();

  const overline = overlineEstado(pedido.estado, grupoDePedido(pedido.estado, pedido.programada_para));

  // Inicial del canal como fallback si no hay emoji.
  const canalIcon = canal?.emoji ?? canal?.nombre?.[0]?.toUpperCase() ?? '·';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-left w-full bg-card border border-border/60 rounded-2xl overflow-hidden',
        'hover:border-border transition-colors',
        variant === 'listo' && 'border-success border-2',
      )}
    >
      {/* HEADER: cuadradito canal + #N con overline de estado · badge pago */}
      <div className="p-3 border-b border-border/50 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={cn(
              'w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0',
              canalSquare.bg,
              canalSquare.text,
            )}
            title={canal?.nombre}
          >
            {canalIcon}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold tabular-nums text-foreground leading-tight">#{pedido.numero_local}</div>
            <div className={cn('text-[10px] uppercase tracking-wider font-semibold leading-tight mt-0.5', overline.text)}>
              {overline.label}
            </div>
          </div>
        </div>
        <BadgePago estadoPago={estadoPago} tipoEntrega={pedido.tipo_entrega} />
      </div>

      {/* CONTENT */}
      <div className="p-3 space-y-2.5">
        {/* CLIENTE */}
        <div>
          <div className="text-sm font-semibold text-foreground truncate">{pedido.cliente_nombre ?? 'Sin nombre'}</div>
          {pedido.cliente_telefono && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-1">
              <Phone className="h-2.5 w-2.5 shrink-0" />
              <span className="tabular-nums truncate">{pedido.cliente_telefono}</span>
            </div>
          )}
          {pedido.tipo_entrega === 'delivery' && pedido.cliente_direccion && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-1">
              <MapPin className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{pedido.cliente_direccion}</span>
            </div>
          )}
          {pedido.tipo_entrega === 'retiro' && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-1">
              <Home className="h-2.5 w-2.5 shrink-0" />
              <span>Retiro en local</span>
            </div>
          )}
        </div>

        {/* PROGRAMADO PARA hora futura */}
        {pedido.programada_para && (
          <div className="flex items-center gap-1.5 rounded-md bg-sky-500/10 border border-sky-500/30 px-2 py-1 text-[11px]">
            <Clock className="h-3 w-3 text-sky-400 shrink-0" />
            <span className="text-sky-400 font-medium truncate">
              Para {new Date(pedido.programada_para).toLocaleString('es-AR', {
                weekday: 'short', hour: '2-digit', minute: '2-digit',
              })}
            </span>
          </div>
        )}

        {/* ITEMS — sin iconos, solo cantidad × nombre */}
        {lineas.length > 0 && (
          <div className="space-y-1">
            {lineas.map((l, i) => (
              <div key={i} className="flex items-baseline gap-2 text-[11px] leading-snug">
                <span className="font-semibold text-foreground tabular-nums shrink-0">{l.qty}×</span>
                <span className="text-muted-foreground truncate">{l.nombre}</span>
              </div>
            ))}
            {resto > 0 && (
              <div className="text-[10px] text-muted-foreground italic pl-0.5">
                + {resto} {resto === 1 ? 'ítem más' : 'ítems más'}
              </div>
            )}
          </div>
        )}

        {/* ACLARACIÓN CLIENTE */}
        {aclaracion && (
          <div className="rounded-md bg-warning/15 border border-warning/30 px-2 py-1 flex items-start gap-1">
            <MessageSquareWarning className="h-3 w-3 text-warning shrink-0 mt-0.5" />
            <p className="text-[11px] text-warning-foreground italic line-clamp-1">{aclaracion}</p>
          </div>
        )}

        {/* TIMER + TOTAL — separados por hairline */}
        <div className="pt-2.5 border-t border-border/40 flex items-center justify-between">
          <div className="flex items-center gap-1 text-xs">
            <Timer className="h-3.5 w-3.5 text-muted-foreground" />
            <UrgencyTimer desdeIso={pedido.created_at} />
          </div>
          <strong className="text-base font-bold text-foreground tabular-nums">{formatARS(Number(pedido.total))}</strong>
        </div>
      </div>
    </button>
  );
}

