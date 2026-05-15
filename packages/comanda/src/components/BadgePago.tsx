import { cn } from '@/lib/utils';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import type { TipoEntrega } from '@/types/database';
import type { EstadoPagoDerivado } from '@/services/pedidosService';

// Badge de estado de pago para cards de Pedidos.
// Convención AR (Toast adaptado):
//   PAGADO       → verde, cliente ya pagó online por la app del canal
//   PAGA EN LOCAL → rojo, cliente paga al cajero al RETIRAR (alerta visual: no entregar sin cobrar)
//   PAGA AL RETIRAR → rojo, cliente paga al driver con cash en delivery
//
// El segundo y tercer caso son visualmente iguales (rojo) pero con label distinto según
// tipo_entrega. Si tipoEntrega es null (programada/borrador) cae al genérico "PENDIENTE".
interface Props {
  estadoPago: EstadoPagoDerivado;
  tipoEntrega: TipoEntrega | null;
  size?: 'sm' | 'md';
}

export function BadgePago({ estadoPago, tipoEntrega, size = 'sm' }: Props) {
  if (estadoPago === 'pagado') {
    return (
      <span className={cn(
        'inline-flex items-center gap-1 rounded-full font-semibold uppercase tracking-wide',
        'bg-success/15 text-success border border-success/30',
        size === 'sm' ? 'text-[10px] px-2 py-0.5' : 'text-xs px-2.5 py-1',
      )}>
        <CheckCircle2 className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
        Pagado
      </span>
    );
  }

  const label =
    tipoEntrega === 'retiro' ? 'Paga en local' :
    tipoEntrega === 'delivery' ? 'Paga al retirar' :
    'Pendiente';

  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full font-semibold uppercase tracking-wide',
      'bg-destructive/15 text-destructive border border-destructive/30',
      size === 'sm' ? 'text-[10px] px-2 py-0.5' : 'text-xs px-2.5 py-1',
    )}>
      <AlertCircle className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
      {label}
    </span>
  );
}
