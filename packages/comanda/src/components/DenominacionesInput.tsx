import { useMemo } from 'react';
import { Banknote, Coins } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatARS } from '@/lib/format';
import { cn } from '@/lib/utils';

// Denominaciones AR vigentes a may-2026. Si BCRA emite nuevas (ej. $20k),
// agregar arriba en la lista.
const BILLETES = [10000, 2000, 1000, 500, 200, 100, 50, 20, 10] as const;
const MONEDAS = [10, 5, 2, 1] as const;

export interface EfectivoBreakdown {
  billetes: Record<string, number>;
  monedas: Record<string, number>;
  total: number;
}

export function emptyBreakdown(): EfectivoBreakdown {
  const billetes: Record<string, number> = {};
  const monedas: Record<string, number> = {};
  for (const v of BILLETES) billetes[String(v)] = 0;
  for (const v of MONEDAS) monedas[String(v)] = 0;
  return { billetes, monedas, total: 0 };
}

export function calcTotalBreakdown(b: EfectivoBreakdown): number {
  let total = 0;
  for (const [valor, cant] of Object.entries(b.billetes)) total += Number(valor) * (cant || 0);
  for (const [valor, cant] of Object.entries(b.monedas)) total += Number(valor) * (cant || 0);
  return total;
}

interface Props {
  value: EfectivoBreakdown;
  onChange: (b: EfectivoBreakdown) => void;
  disabled?: boolean;
}

export function DenominacionesInput({ value, onChange, disabled }: Props) {
  const total = useMemo(() => calcTotalBreakdown(value), [value]);

  function setBillete(valor: number, cantidad: number) {
    const next = {
      ...value,
      billetes: { ...value.billetes, [String(valor)]: cantidad },
    };
    next.total = calcTotalBreakdown(next);
    onChange(next);
  }

  function setMoneda(valor: number, cantidad: number) {
    const next = {
      ...value,
      monedas: { ...value.monedas, [String(valor)]: cantidad },
    };
    next.total = calcTotalBreakdown(next);
    onChange(next);
  }

  return (
    <div className="space-y-4">
      {/* Billetes */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <Banknote className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Billetes
          </h3>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {BILLETES.map(valor => {
            const cantidad = value.billetes[String(valor)] ?? 0;
            const subtotal = valor * cantidad;
            return (
              <DenomCell
                key={valor}
                valor={valor}
                cantidad={cantidad}
                subtotal={subtotal}
                onChange={n => setBillete(valor, n)}
                disabled={disabled}
              />
            );
          })}
        </div>
      </div>

      {/* Monedas */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <Coins className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Monedas
          </h3>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {MONEDAS.map(valor => {
            const cantidad = value.monedas[String(valor)] ?? 0;
            const subtotal = valor * cantidad;
            return (
              <DenomCell
                key={valor}
                valor={valor}
                cantidad={cantidad}
                subtotal={subtotal}
                onChange={n => setMoneda(valor, n)}
                disabled={disabled}
              />
            );
          })}
        </div>
      </div>

      {/* Total */}
      <div className="rounded-md border border-primary/30 bg-primary/5 px-4 py-3 flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">Total contado</span>
        <span className="text-2xl font-bold tabular-nums">{formatARS(total)}</span>
      </div>
    </div>
  );
}

interface DenomCellProps {
  valor: number;
  cantidad: number;
  subtotal: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}

function DenomCell({ valor, cantidad, subtotal, onChange, disabled }: DenomCellProps) {
  const id = `denom-${valor}`;
  return (
    <div className={cn('rounded-md border border-border p-2', cantidad > 0 && 'bg-muted/40')}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        ${valor.toLocaleString('es-AR')}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={cantidad === 0 ? '' : cantidad}
        onChange={e => onChange(Math.max(0, Number(e.target.value) || 0))}
        placeholder="0"
        disabled={disabled}
        className="h-8 text-right tabular-nums mt-1"
      />
      {subtotal > 0 && (
        <div className="text-[10px] text-muted-foreground tabular-nums mt-1 text-right">
          = {formatARS(subtotal)}
        </div>
      )}
    </div>
  );
}
