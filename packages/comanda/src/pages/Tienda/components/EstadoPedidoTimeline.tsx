import { Check, Clock, ChefHat, Package, Bike } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PasoTimeline {
  key: string;
  label: string;
  icon: typeof Check;
}

// Pasos del flow tienda online. lista vs entregada según tipo_entrega.
export const PASOS_RETIRO: PasoTimeline[] = [
  { key: 'necesita_aprobacion', label: 'Esperando aprobación', icon: Clock },
  { key: 'enviada',             label: 'En cocina',            icon: ChefHat },
  { key: 'lista',               label: 'Listo para retirar',   icon: Package },
  { key: 'entregada',           label: 'Entregado',            icon: Check },
];

export const PASOS_DELIVERY: PasoTimeline[] = [
  { key: 'necesita_aprobacion', label: 'Esperando aprobación', icon: Clock },
  { key: 'enviada',             label: 'En cocina',            icon: ChefHat },
  { key: 'lista',               label: 'En camino',            icon: Bike },
  { key: 'entregada',           label: 'Entregado',            icon: Check },
];

interface Props {
  pasos: PasoTimeline[];
  estadoActual: string;
}

// Timeline vertical para TiendaConfirmacion. Estado actual con anillo
// pulsante coral. Pasos completados con tilde verde. Pendientes en gris.
export function EstadoPedidoTimeline({ pasos, estadoActual }: Props) {
  const idxActual = pasos.findIndex((p) => p.key === estadoActual);

  return (
    <ol className="relative space-y-0">
      {pasos.map((p, i) => {
        const Icon = p.icon;
        const completado = idxActual > i;
        const enCurso = idxActual === i;
        const pendiente = idxActual < i;
        const ultimo = i === pasos.length - 1;

        return (
          <li key={p.key} className="flex gap-4 relative">
            {/* Línea vertical conectora */}
            {!ultimo && (
              <span
                aria-hidden
                className={cn(
                  'absolute left-[15px] top-8 w-0.5 h-12 -z-0',
                  completado ? 'bg-success' : 'bg-gray-200',
                )}
              />
            )}
            {/* Bullet con icono */}
            <div className={cn(
              'h-8 w-8 flex-shrink-0 rounded-full flex items-center justify-center z-10 border-2 transition-colors',
              completado && 'bg-success border-success text-white',
              enCurso && 'bg-primary border-primary text-white animate-pulse',
              pendiente && 'bg-white border-gray-300 text-gray-400',
            )}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="flex-1 pb-12 pt-1">
              <div className={cn(
                'text-sm transition-colors',
                completado && 'text-foreground/70',
                enCurso && 'text-foreground font-semibold',
                pendiente && 'text-foreground/40',
              )}>
                {p.label}
              </div>
              {enCurso && (
                <div className="text-xs text-foreground/60 mt-0.5">Estado actual</div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
