import React from 'react';
import { Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
}

export const VentaFooter = React.memo(function VentaFooter({
  venta,
  editable,
  onCobrar,
}: VentaFooterProps) {
  return (
    <div className="p-3 border-t border-border bg-card space-y-2">
      <Row label="Subtotal" value={formatARS(venta.subtotal)} />
      {venta.descuento_total > 0 && (
        <Row label="Descuento" value={'−' + formatARS(venta.descuento_total)} />
      )}
      {venta.propina > 0 && <Row label="Propina" value={formatARS(venta.propina)} />}
      <Row label="Total" value={formatARS(venta.total)} bold />

      <Button
        type="button"
        variant="success"
        size="lg"
        className="w-full mt-2"
        onClick={onCobrar}
        disabled={!editable || venta.total <= 0}
      >
        <Wallet className="h-4 w-4 mr-2" />
        Cobrar y enviar
      </Button>
    </div>
  );
});
