import { Phone, MapPin, Home, MessageSquareWarning, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { CanalBadge } from './CanalBadge';
import { BadgePago } from './BadgePago';
import { UrgencyTimer } from './UrgencyTimer';
import { formatARS } from '@/lib/format';
import { calcularEstadoPago, grupoDePedido, type PedidoGrupo } from '@/services/pedidosService';
import type { Canal, EstadoVenta, VentaPos, VentaPosItem, VentaPosPago } from '@/types/database';

// Label + color del badge de estado que se pinta al lado del #número.
// Mismo criterio en las 5 tabs — en "Todos" es la señal visual clave; en las
// tabs filtradas es redundante pero consistente y ayuda a distinguir sub-estados
// dentro de "Aceptadas" (en carga vs en cocina vs listo vs en camino).
const ESTADO_BADGE: Record<EstadoVenta, { label: string; classes: string }> = {
  abierta:             { label: 'En carga',   classes: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900' },
  necesita_aprobacion: { label: 'Por aceptar', classes: 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200 border-amber-200 dark:border-amber-900' },
  programada:          { label: 'Programada', classes: 'bg-sky-100 text-sky-900 dark:bg-sky-950/50 dark:text-sky-200 border-sky-200 dark:border-sky-900' },
  enviada:             { label: 'En cocina',  classes: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900' },
  lista:               { label: 'Lista',      classes: 'bg-green-200 text-green-900 dark:bg-green-900/60 dark:text-green-100 border-green-300 dark:border-green-800' },
  en_camino:           { label: 'En camino',  classes: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900' },
  entregada:           { label: 'Entregada',  classes: 'bg-muted text-muted-foreground border-border' },
  cobrada:             { label: 'Cobrada',    classes: 'bg-muted text-muted-foreground border-border' },
  anulada:             { label: 'Anulada',    classes: 'bg-destructive/10 text-destructive border-destructive/30' },
};

// Cuando programada_para es futuro el grupo lógico es "programadas" (aunque el
// estado sea 'necesita_aprobacion' o 'abierta'): mostramos ese label para que la
// card sea coherente con la tab en la que aparece.
function badgeEstado(estado: EstadoVenta, grupo: PedidoGrupo): { label: string; classes: string } {
  if (grupo === 'programadas') return ESTADO_BADGE.programada;
  return ESTADO_BADGE[estado] ?? ESTADO_BADGE.abierta;
}

// Mapeo de slug de canal a tonalidad del HEADER de la card (no del badge — la card
// entera se "tinta" en suave para identificación instantánea).
// Coherente con CanalBadge.tsx (mismos colores pero versión más sutil para fondo amplio).
const CANAL_HEADER_BG: Record<string, string> = {
  rappi:           'bg-red-50 dark:bg-red-950/40',
  'pedidos-ya':    'bg-purple-50 dark:bg-purple-950/40',
  whatsapp:        'bg-green-50 dark:bg-green-950/40',
  'tienda-propia': 'bg-orange-50 dark:bg-orange-950/40',
  salon:           'bg-amber-50 dark:bg-amber-950/40',
  mostrador:       'bg-blue-50 dark:bg-blue-950/40',
  'menu-qr':       'bg-pink-50 dark:bg-pink-950/40',
};
const FALLBACK_HEADER_BG = 'bg-muted/50';

interface Props {
  pedido: VentaPos & { items: VentaPosItem[]; pagos?: VentaPosPago[] };
  canales: Canal[];
  variant?: 'default' | 'listo'; // pedido en 'lista' usa borde verde sólido
  onClick: () => void;
}

// Resumen de items para la card: max 2 nombres + "y N más".
// listPedidosPorTab hace JOIN a items para resolver nombre + emoji.
function resumenItems(items: (VentaPosItem & { item?: { nombre: string | null; emoji: string | null } | null })[]): { lineas: { qty: number; nombre: string; emoji: string | null }[]; resto: number } {
  const activos = items.filter((it) => it.estado !== 'anulado');
  const top = activos.slice(0, 2);
  const lineas = top.map((it) => ({
    qty: Number(it.cantidad),
    nombre: it.item?.nombre ?? `Item #${it.item_id}`,
    emoji: it.item?.emoji ?? null,
  }));
  return { lineas, resto: Math.max(0, activos.length - 2) };
}

export function PedidoCard({ pedido, canales, variant = 'default', onClick }: Props) {
  const canal = canales.find((c) => c.id === pedido.canal_id);
  const headerBg = canal ? (CANAL_HEADER_BG[canal.slug] ?? FALLBACK_HEADER_BG) : FALLBACK_HEADER_BG;

  const { lineas, resto } = resumenItems(pedido.items);

  const estadoPago = calcularEstadoPago(Number(pedido.total), pedido.pagos ?? []);
  const aclaracion = pedido.notas?.trim();

  return (
    <Card
      className={cn(
        'overflow-hidden cursor-pointer transition-colors hover:border-primary/50',
        variant === 'listo' && 'border-success border-2',
      )}
      onClick={onClick}
    >
      {/* HEADER coloreado por canal */}
      <div className={cn('px-3 py-1.5 border-b flex items-center justify-between gap-2', headerBg)}>
        <div className="flex items-center gap-1.5 min-w-0">
          {canal && <CanalBadge slug={canal.slug} label={canal.nombre} emoji={canal.emoji} />}
          <strong className="text-sm font-semibold tabular-nums">#{pedido.numero_local}</strong>
          {(() => {
            const b = badgeEstado(pedido.estado, grupoDePedido(pedido.estado, pedido.programada_para));
            return (
              <span className={cn(
                'inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-medium border shrink-0',
                b.classes,
              )}>
                {b.label}
              </span>
            );
          })()}
        </div>
        <BadgePago estadoPago={estadoPago} tipoEntrega={pedido.tipo_entrega} />
      </div>

      <CardContent className="p-3 space-y-1.5">
        {/* CLIENTE — nombre + teléfono en una sola línea */}
        <div className="flex items-baseline justify-between gap-2 min-w-0">
          <div className="text-sm font-medium truncate flex-1 min-w-0">{pedido.cliente_nombre ?? 'Sin nombre'}</div>
          {pedido.cliente_telefono && (
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0 tabular-nums">
              <Phone className="h-2.5 w-2.5" /> {pedido.cliente_telefono}
            </div>
          )}
        </div>

        {/* ENTREGA — una línea, truncada */}
        {pedido.tipo_entrega === 'delivery' && pedido.cliente_direccion && (
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground min-w-0">
            <MapPin className="h-2.5 w-2.5 flex-shrink-0" />
            <span className="truncate">{pedido.cliente_direccion}</span>
          </div>
        )}
        {pedido.tipo_entrega === 'retiro' && (
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Home className="h-2.5 w-2.5" /> Retiro en local
          </div>
        )}

        {/* PROGRAMADO PARA hora futura — banner destacado (compacto) */}
        {pedido.programada_para && (
          <div className="flex items-center gap-1.5 rounded-md bg-primary/10 border border-primary/30 px-2 py-1 text-[11px]">
            <Clock className="h-3 w-3 text-primary" />
            <span className="text-primary font-medium truncate">
              Para {new Date(pedido.programada_para).toLocaleString('es-AR', {
                weekday: 'short', hour: '2-digit', minute: '2-digit',
              })}
            </span>
          </div>
        )}

        {/* ITEMS RESUMEN (máx 2) */}
        {lineas.length > 0 && (
          <ul className="text-[11px] space-y-0 pt-1 border-t border-border/50 leading-snug">
            {lineas.map((l, i) => (
              <li key={i} className="text-muted-foreground truncate">
                <span className="font-medium text-foreground">{l.qty}×</span>
                {l.emoji && <span className="ml-1">{l.emoji}</span>} {l.nombre}
              </li>
            ))}
            {resto > 0 && (
              <li className="text-muted-foreground italic">y {resto} más…</li>
            )}
          </ul>
        )}

        {/* ACLARACIÓN CLIENTE (banner amarillo, imposible no verla — Toast pattern) */}
        {aclaracion && (
          <div className="rounded-md bg-warning/15 border border-warning/30 px-2 py-1 flex items-start gap-1">
            <MessageSquareWarning className="h-3 w-3 text-warning flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-warning-foreground italic line-clamp-1">{aclaracion}</p>
          </div>
        )}

        {/* TIMER + TOTAL */}
        <div className="flex items-center justify-between pt-0.5">
          <UrgencyTimer desdeIso={pedido.created_at} />
          <strong className="text-base tabular-nums">{formatARS(Number(pedido.total))}</strong>
        </div>
      </CardContent>
    </Card>
  );
}
