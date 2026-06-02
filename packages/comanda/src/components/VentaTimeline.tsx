// packages/comanda/src/components/VentaTimeline.tsx
// Timeline visual para pedidos / ventas — Plan Fase 1 Brainstorm #8 (2026-06-01).
//
// Lee los timestamps de ventas_pos y muestra el progreso del pedido como
// línea de tiempo vertical con checks verdes en etapas pasadas, indicador
// destacado en la actual, etapas futuras en gris.
//
// Etapas mostradas dependen de tipo_entrega:
//   - DELIVERY: Recibido → Aprobado → Lista cocina → Rider asignado → En camino → Entregado
//   - RETIRO:   Recibido → Aprobado → Lista cocina → Entregado
//   - MESA/null:Recibido → Aprobado → Lista cocina → Entregado

import type { VentaPos } from '@/types/database';
import { CheckCircle2, Circle, X, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  venta: VentaPos;
}

interface Etapa {
  key: string;
  label: string;
  timestamp: string | null;
  visible: boolean;
}

function formatHora(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function VentaTimeline({ venta }: Props) {
  // Si está anulada, mostrar banner rojo con motivo
  if (venta.estado === 'anulada') {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 flex items-start gap-2">
        <X className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
        <div className="text-xs">
          <div className="font-semibold text-destructive">Pedido anulado</div>
          <div className="text-muted-foreground mt-0.5">
            {formatHora(venta.anulada_at)}
          </div>
        </div>
      </div>
    );
  }

  const esDelivery = venta.tipo_entrega === 'delivery';

  const etapas: Etapa[] = [
    {
      key: 'recibido',
      label: 'Recibido',
      timestamp: venta.created_at,
      visible: true,
    },
    {
      key: 'aprobado',
      label: 'Aprobado',
      timestamp: venta.enviada_at ?? null,
      visible: true,
    },
    {
      key: 'listo',
      label: 'Listo en cocina',
      timestamp: venta.listo_at ?? null,
      visible: true,
    },
    {
      key: 'asignado_rider',
      label: 'Rider asignado',
      timestamp: venta.asignado_rider_at ?? null,
      visible: esDelivery,
    },
    {
      key: 'en_camino',
      label: 'En camino',
      timestamp: venta.en_camino_at ?? null,
      visible: esDelivery,
    },
    {
      key: 'entregado',
      label: 'Entregado',
      timestamp: venta.entregada_at ?? null,
      visible: true,
    },
  ];

  const visibles = etapas.filter((e) => e.visible);

  // Encontrar la última etapa completada para destacar
  let ultimaCompletadaIdx = -1;
  for (let i = visibles.length - 1; i >= 0; i--) {
    const etapa = visibles[i];
    if (etapa && etapa.timestamp) {
      ultimaCompletadaIdx = i;
      break;
    }
  }

  return (
    <ol className="space-y-2.5">
      {visibles.map((etapa, idx) => {
        const completada = etapa.timestamp !== null;
        const esActual = idx === ultimaCompletadaIdx && idx !== visibles.length - 1;
        const futura = !completada;
        return (
          <li key={etapa.key} className="flex items-start gap-2.5">
            <div className="flex-shrink-0 mt-0.5">
              {completada ? (
                <CheckCircle2
                  className={cn(
                    'h-4 w-4',
                    esActual ? 'text-primary' : 'text-success',
                  )}
                />
              ) : (
                <Circle className="h-4 w-4 text-muted-foreground/40" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div
                className={cn(
                  'text-xs',
                  futura ? 'text-muted-foreground' : 'font-medium',
                  esActual && 'text-primary font-semibold',
                )}
              >
                {etapa.label}
              </div>
              {etapa.timestamp && (
                <div className="text-[10px] text-muted-foreground tabular-nums flex items-center gap-1 mt-0.5">
                  <Clock className="h-2.5 w-2.5" />
                  {formatHora(etapa.timestamp)}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
