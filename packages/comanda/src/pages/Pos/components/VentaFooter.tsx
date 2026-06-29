import React from 'react';
import { Send, PauseCircle, LayoutGrid, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatARS } from '../../../lib/format';
import { cn } from '@/lib/utils';
import type { VentaPos } from '../../../types/database';

export interface VentaFooterProps {
  venta: VentaPos;
  editable: boolean;
  totalHold: number;
  todosEnStay: boolean;
  onMarchar: () => void;
  onHold: () => void;
  onMesa: () => void;
  onCobrar: () => void;
}

export const VentaFooter = React.memo(function VentaFooter({
  venta,
  editable,
  totalHold,
  todosEnStay,
  onMarchar,
  onHold,
  onMesa,
  onCobrar,
}: VentaFooterProps) {
  return (
    <div className="shrink-0 border-t border-border bg-card">
      {/* Resumen de totales */}
      <div className="px-3 pt-2.5 pb-2 space-y-0.5">
        <div className="flex justify-between text-sm text-muted-foreground">
          <span>Subtotal</span>
          <span className="tabular-nums text-foreground">{formatARS(venta.subtotal)}</span>
        </div>
        {venta.descuento_total > 0 && (
          <div className="flex justify-between text-sm text-muted-foreground">
            <span>Descuento</span>
            <span className="tabular-nums text-foreground">−{formatARS(venta.descuento_total)}</span>
          </div>
        )}
        {venta.propina > 0 && (
          <div className="flex justify-between text-sm text-muted-foreground">
            <span>Propina</span>
            <span className="tabular-nums text-foreground">{formatARS(venta.propina)}</span>
          </div>
        )}
        <div className="flex justify-between font-semibold text-foreground pt-0.5">
          <span>Total</span>
          <span className="tabular-nums text-base">{formatARS(venta.total)}</span>
        </div>
      </div>

      {/* Barra de 4 acciones principales */}
      <div className="grid grid-cols-2 gap-1.5 px-2 pb-2.5">
        {/* Marchar — enviar items pendientes a cocina */}
        <Button
          size="sm"
          onClick={onMarchar}
          disabled={!editable || totalHold === 0}
          className={cn(
            'gap-1.5 text-white transition-colors',
            totalHold > 0 && editable
              ? 'bg-emerald-600 hover:bg-emerald-700'
              : 'bg-emerald-600/40',
          )}
        >
          <Send className="h-3.5 w-3.5" />
          Marchar
          {totalHold > 0 && (
            <span className="inline-flex items-center justify-center h-4 min-w-[1rem] rounded-full bg-white/30 text-[10px] font-bold px-1 tabular-nums">
              {totalHold}
            </span>
          )}
        </Button>

        {/* Hold — retener / liberar todos los items pendientes */}
        <Button
          variant="outline"
          size="sm"
          onClick={onHold}
          disabled={!editable || totalHold === 0}
          className={cn(
            'gap-1.5',
            todosEnStay && 'border-purple-400 text-purple-700 bg-purple-50 dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-700',
          )}
        >
          <PauseCircle className="h-3.5 w-3.5" />
          {todosEnStay ? 'Liberar' : 'Hold'}
        </Button>

        {/* Control de mesa — volver al salón */}
        <Button
          variant="outline"
          size="sm"
          onClick={onMesa}
          className="gap-1.5"
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          Control mesa
        </Button>

        {/* Cobrar — abrir pantalla de pago */}
        <Button
          variant="success"
          size="sm"
          onClick={onCobrar}
          disabled={!editable || venta.total <= 0}
          className="gap-1.5"
        >
          <Wallet className="h-3.5 w-3.5" />
          Cobrar
        </Button>
      </div>
    </div>
  );
});
