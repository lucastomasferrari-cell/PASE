import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Percent, DollarSign } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  type DescuentoTipo, requiereOverride, calcularMontoDescuento, aplicarDescuento,
} from '@/services/descuentosService';
import { useIdempotencyKey } from '@/lib/idempotency';
import { ManagerOverrideDialog } from './ManagerOverrideDialog';
import { formatARS } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ventaId: number;
  subtotal: number;
  total: number;
  onAplicado: () => void;
}

const MOTIVO_MIN = 5;

export function DiscountDialog({ open, onOpenChange, ventaId, subtotal, total, onAplicado }: Props) {
  const [tipo, setTipo] = useState<DescuentoTipo>('porcentaje');
  const [valor, setValor] = useState<number>(10);
  const [motivo, setMotivo] = useState('');
  const [showOverride, setShowOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  const idempotencyKey = useIdempotencyKey(open ? `${ventaId}-open` : 'closed');

  useEffect(() => {
    if (open) { setTipo('porcentaje'); setValor(10); setMotivo(''); setShowOverride(false); setSaving(false); }
  }, [open]);

  const monto = calcularMontoDescuento(tipo, valor, subtotal);
  const requiereOver = requiereOverride(tipo, valor, total);
  const totalConDescuento = Math.max(0, total - monto);

  async function aplicar(args?: { managerId: string }) {
    if (motivo.trim().length < MOTIVO_MIN) {
      toast.error(`Motivo: mínimo ${MOTIVO_MIN} caracteres`);
      return;
    }
    if (monto <= 0) { toast.error('Monto inválido'); return; }
    setSaving(true);
    const { error } = await aplicarDescuento(
      {
        ventaId, tipo, valor, motivo: motivo.trim(),
        managerId: args?.managerId,
        idempotencyKey,
      },
      subtotal,
    );
    setSaving(false);
    if (error) { toast.error(error); return; }
    toast.success(`Descuento aplicado: −${formatARS(monto)}`);
    onAplicado();
    onOpenChange(false);
  }

  function intentarAplicar() {
    if (motivo.trim().length < MOTIVO_MIN) {
      toast.error(`Motivo: mínimo ${MOTIVO_MIN} caracteres`); return;
    }
    if (requiereOver) setShowOverride(true);
    else aplicar();
  }

  return (
    <>
      <Dialog open={open && !showOverride} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Aplicar descuento</DialogTitle>
            <DialogDescription>
              Total actual: <strong className="tabular-nums">{formatARS(total)}</strong>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={tipo === 'porcentaje' ? 'default' : 'outline'}
                onClick={() => setTipo('porcentaje')}
              >
                <Percent className="h-4 w-4 mr-2" />
                Porcentaje
              </Button>
              <Button
                type="button"
                variant={tipo === 'monto' ? 'default' : 'outline'}
                onClick={() => setTipo('monto')}
              >
                <DollarSign className="h-4 w-4 mr-2" />
                Monto fijo
              </Button>
            </div>

            <div className="space-y-2">
              <Label htmlFor="valor">
                {tipo === 'porcentaje' ? 'Porcentaje (%)' : 'Monto ($)'}
              </Label>
              <Input
                id="valor"
                type="number"
                step={tipo === 'porcentaje' ? 1 : 100}
                min={0}
                max={tipo === 'porcentaje' ? 100 : total}
                value={valor}
                onChange={(e) => setValor(Number(e.target.value))}
                className="h-11 tabular-nums"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="motivo">Motivo</Label>
              <Textarea
                id="motivo"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                rows={2}
                placeholder="Cliente frecuente / promo / etc."
              />
            </div>

            <div className={cn('rounded-md p-3 text-sm space-y-1',
              requiereOver ? 'bg-warning/10 border border-warning/30' : 'bg-muted',
            )}>
              <div className="flex justify-between">
                <span>Descuento</span>
                <strong className="tabular-nums">−{formatARS(monto)}</strong>
              </div>
              <div className="flex justify-between text-base">
                <strong>Total con descuento</strong>
                <strong className="tabular-nums">{formatARS(totalConDescuento)}</strong>
              </div>
              {requiereOver && (
                <div className="text-xs text-warning font-medium pt-2">
                  ⚠ Requiere autorización de manager (supera 15%)
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button
              onClick={intentarAplicar}
              disabled={saving || monto <= 0 || motivo.trim().length < MOTIVO_MIN}
            >
              {saving ? 'Aplicando…' : (requiereOver ? 'Pedir autorización' : 'Aplicar descuento')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManagerOverrideDialog
        open={showOverride}
        onOpenChange={(o) => { setShowOverride(o); if (!o) onOpenChange(false); }}
        accion="Aplicar descuento grande"
        descripcion={`Descuento ${tipo === 'porcentaje' ? `${valor}%` : formatARS(valor)} sobre total ${formatARS(total)}. Total final: ${formatARS(totalConDescuento)}.`}
        onAuthorized={async ({ managerId }) => { await aplicar({ managerId }); }}
      />
    </>
  );
}
