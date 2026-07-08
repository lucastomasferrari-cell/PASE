import React from 'react';
import { Send, PauseCircle, LayoutGrid, Wallet, CheckCircle2, Banknote } from 'lucide-react';
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
  /** Solo se usa en modo 'pedidos'. Si se pasa, el footer muestra Marchar + Listo. */
  onListo?: () => void;
  /** Aplicar 10% descuento efectivo. Si undefined, no muestra el botón. */
  onDescuentoEfectivo?: () => void;
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
  onListo,
  onDescuentoEfectivo,
}: VentaFooterProps) {
  const esModoPedidos = venta.modo === 'pedidos';
  const tieneDescuento = venta.descuento_total > 0;
  return (
    <div className="shrink-0 border-t border-border/40 bg-card">
      {/* Botón rápido: descuento 10% efectivo. Se muestra solo si hay total.
          Se desactiva si ya hay descuento aplicado (para no acumular). */}
      {onDescuentoEfectivo && editable && venta.subtotal > 0 && (
        <div className="px-3 pt-2 pb-1">
          <Button
            type="button"
            variant={tieneDescuento ? 'outline' : 'secondary'}
            size="sm"
            onClick={onDescuentoEfectivo}
            disabled={tieneDescuento}
            className={cn(
              'w-full gap-1.5',
              tieneDescuento && 'text-success border-success/40 bg-success/5',
            )}
          >
            <Banknote className="h-4 w-4" />
            {tieneDescuento ? 'Descuento efectivo aplicado' : 'Aplicar 10% descuento efectivo'}
          </Button>
        </div>
      )}

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

      {/* Barra de acciones — 2 botones en pedidos (Listo + Cobrar), 4 en mesa/mostrador.
          En pedidos los items se auto-marchan al agregarlos, por eso Marchar
          desaparece — el cajero solo elige salir al listado o cobrar. */}
      {esModoPedidos ? (
        <div className="grid grid-cols-2 gap-1.5 px-2 pb-2.5">
          <Button
            variant="outline"
            size="sm"
            onClick={onListo}
            disabled={!editable}
            className="gap-1.5"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Listo
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={onCobrar}
            disabled={!editable || venta.total <= 0}
            className="gap-1.5"
          >
            <Wallet className="h-3.5 w-3.5" />
            Cobrar
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5 px-2 pb-2.5">
          <Button
            variant="default"
            size="sm"
            onClick={onMarchar}
            disabled={!editable || totalHold === 0}
            className="gap-1.5"
          >
            <Send className="h-3.5 w-3.5" />
            Marchar
            {totalHold > 0 && (
              <span className="inline-flex items-center justify-center h-4 min-w-[1rem] rounded-full bg-white/25 text-[10px] font-bold px-1 tabular-nums">
                {totalHold}
              </span>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onHold}
            disabled={!editable || totalHold === 0}
            className={cn(
              'gap-1.5',
              todosEnStay && 'bg-accent text-foreground',
            )}
          >
            <PauseCircle className="h-3.5 w-3.5" />
            {todosEnStay ? 'Liberar' : 'Hold'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onMesa}
            className="gap-1.5"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Control mesa
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={onCobrar}
            disabled={!editable || venta.total <= 0}
            className="gap-1.5"
          >
            <Wallet className="h-3.5 w-3.5" />
            Cobrar
          </Button>
        </div>
      )}
    </div>
  );
});
