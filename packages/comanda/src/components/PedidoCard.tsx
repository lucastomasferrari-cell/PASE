import { Phone, MapPin, Home, CheckCircle2, ChefHat, MessageSquareWarning } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CanalBadge } from './CanalBadge';
import { BadgePago } from './BadgePago';
import { UrgencyTimer } from './UrgencyTimer';
import { formatARS } from '@/lib/format';
import { calcularEstadoPago } from '@/services/pedidosService';
import type { Canal, VentaPos, VentaPosItem, VentaPosPago } from '@/types/database';

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
  variant?: 'default' | 'listo'; // tab 'Listos' usa borde verde sólido
  onClick: () => void;
  onAccion: () => Promise<void>;
}

// Resumen de items para la card: max 3 nombres + "y N más".
function resumenItems(items: VentaPosItem[]): { lineas: { qty: number; nombre: string }[]; resto: number } {
  // Solo no anulados. cantidad acumulada por nombre (item_id no podemos resolver client-side sin join).
  const activos = items.filter((it) => it.estado !== 'anulado');
  const top = activos.slice(0, 3);
  // Para nombre, usamos "Item #ID" como fallback porque el join a items completos sería extra costo.
  // En el detalle (PedidoDetalle) sí se resuelven nombres.
  const lineas = top.map((it) => ({
    qty: Number(it.cantidad),
    nombre: `Item #${it.item_id}`,
  }));
  return { lineas, resto: Math.max(0, activos.length - 3) };
}

export function PedidoCard({ pedido, canales, variant = 'default', onClick, onAccion }: Props) {
  const canal = canales.find((c) => c.id === pedido.canal_id);
  const headerBg = canal ? (CANAL_HEADER_BG[canal.slug] ?? FALLBACK_HEADER_BG) : FALLBACK_HEADER_BG;

  const { lineas, resto } = resumenItems(pedido.items);

  const estadoPago = calcularEstadoPago(Number(pedido.total), pedido.pagos ?? []);
  const aclaracion = pedido.notas?.trim();

  // Botón único contextual según estado (Toast-style: una sola acción visible).
  const accionLabel =
    pedido.estado === 'necesita_aprobacion' ? 'Aprobar' :
    pedido.estado === 'enviada' ? 'Marcar listo' :
    pedido.estado === 'lista' ? 'Entregado' :
    null;
  const AccionIcon =
    pedido.estado === 'necesita_aprobacion' ? CheckCircle2 :
    pedido.estado === 'enviada' ? ChefHat :
    CheckCircle2;
  const accionVariant: 'success' | 'default' =
    pedido.estado === 'necesita_aprobacion' || pedido.estado === 'lista' ? 'success' : 'default';

  return (
    <Card
      className={cn(
        'overflow-hidden cursor-pointer transition-colors hover:border-primary/50',
        variant === 'listo' && 'border-success border-2',
      )}
      onClick={onClick}
    >
      {/* HEADER coloreado por canal */}
      <div className={cn('px-4 py-2.5 border-b flex items-center justify-between gap-2', headerBg)}>
        <div className="flex items-center gap-2 min-w-0">
          {canal && <CanalBadge slug={canal.slug} label={canal.nombre} emoji={canal.emoji} />}
          <strong className="text-sm font-semibold tabular-nums">#{pedido.numero_local}</strong>
        </div>
        <BadgePago estadoPago={estadoPago} tipoEntrega={pedido.tipo_entrega} />
      </div>

      <CardContent className="p-4 space-y-2.5">
        {/* CLIENTE */}
        <div>
          <div className="text-sm font-medium truncate">{pedido.cliente_nombre ?? 'Sin nombre'}</div>
          {pedido.cliente_telefono && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
              <Phone className="h-3 w-3" /> {pedido.cliente_telefono}
            </div>
          )}
        </div>

        {/* ENTREGA */}
        {pedido.tipo_entrega === 'delivery' && pedido.cliente_direccion && (
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3 mt-0.5 flex-shrink-0" />
            <span className="line-clamp-2">{pedido.cliente_direccion}</span>
          </div>
        )}
        {pedido.tipo_entrega === 'retiro' && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Home className="h-3 w-3" /> Retiro en local
          </div>
        )}

        {/* ITEMS RESUMEN */}
        {lineas.length > 0 && (
          <ul className="text-xs space-y-0.5 pt-1 border-t border-border/50">
            {lineas.map((l, i) => (
              <li key={i} className="text-muted-foreground">
                <span className="font-medium text-foreground">{l.qty}×</span> {l.nombre}
              </li>
            ))}
            {resto > 0 && (
              <li className="text-muted-foreground italic">y {resto} más…</li>
            )}
          </ul>
        )}

        {/* ACLARACIÓN CLIENTE (banner amarillo, imposible no verla — Toast pattern) */}
        {aclaracion && (
          <div className="rounded-md bg-warning/15 border border-warning/30 px-2.5 py-1.5 flex items-start gap-1.5">
            <MessageSquareWarning className="h-3.5 w-3.5 text-warning flex-shrink-0 mt-px" />
            <p className="text-xs text-warning-foreground italic line-clamp-2">{aclaracion}</p>
          </div>
        )}

        {/* TIMER + TOTAL */}
        <div className="flex items-center justify-between pt-1">
          <UrgencyTimer desdeIso={pedido.created_at} />
          <strong className="text-lg tabular-nums">{formatARS(Number(pedido.total))}</strong>
        </div>

        {/* BOTÓN ÚNICO CONTEXTUAL */}
        {accionLabel && (
          <Button
            type="button"
            variant={accionVariant}
            className="w-full mt-1"
            onClick={(e) => { e.stopPropagation(); void onAccion(); }}
          >
            <AccionIcon className="h-4 w-4 mr-2" />
            {accionLabel}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
