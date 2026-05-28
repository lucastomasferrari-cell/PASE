import React from 'react';
import { Wallet, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatARS } from '../../../lib/format';
import { cn } from '@/lib/utils';
import type { VentaPos } from '../../../types/database';

interface RowProps {
  label: string;
  value: string;
  bold?: boolean;
}

function Row({ label, value, bold }: RowProps) {
  return (
    <div
      className={cn(
        'flex justify-between py-1',
        bold ? 'text-base font-semibold text-foreground' : 'text-sm font-normal text-muted-foreground',
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export interface VentaFooterProps {
  venta: VentaPos;
  editable: boolean;
  onCobrar: () => void;
  onDescuento: () => void;
  onTransfer: () => void;
  onMerge: () => void;
  onSplit: () => void;
  onOpenHistorial: () => void;
  onAnular: () => void;
}

export const VentaFooter = React.memo(function VentaFooter({
  venta,
  editable,
  onCobrar,
  onDescuento,
  onTransfer,
  onMerge,
  onSplit,
  onOpenHistorial,
  onAnular,
}: VentaFooterProps) {
  return (
    <div className="p-3 border-t border-border bg-card space-y-2">
      <Row label="Subtotal" value={formatARS(venta.subtotal)} />
      {venta.descuento_total > 0 && (
        <Row label="Descuento" value={'−' + formatARS(venta.descuento_total)} />
      )}
      {venta.propina > 0 && <Row label="Propina" value={formatARS(venta.propina)} />}
      <Row label="Total" value={formatARS(venta.total)} bold />

      <div className="grid grid-cols-[1fr_auto] gap-2 mt-2">
        <Button
          type="button"
          variant="success"
          size="lg"
          onClick={onCobrar}
          disabled={!editable || venta.total <= 0}
        >
          <Wallet className="h-4 w-4 mr-2" />
          Cobrar y enviar
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="lg"
              aria-label="Más opciones"
              disabled={!editable}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={onDescuento}>
              Aplicar descuento
            </DropdownMenuItem>
            {venta.modo === 'salon' && (
              <>
                <DropdownMenuItem onClick={onTransfer}>
                  Cambiar mesa
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onMerge}>
                  Unir con otra mesa
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onClick={onSplit}>
              Partir cuenta
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenHistorial}>
              Ver historial de cambios
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onAnular}
            >
              Anular venta
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});
