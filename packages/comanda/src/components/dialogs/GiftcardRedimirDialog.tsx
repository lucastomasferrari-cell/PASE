// GiftcardRedimirDialog — modal para canjear una giftcard al cobrar.
//
// El cajero tipea el código (ej GIFT-2026-ABC123) y el dialog llama
// `fn_canjear_giftcard` (RPC atómica, anti doble-uso). Si OK, devuelve
// monto + comprador + para, y onRedimida queda como callback para que el
// PaymentDialog agregue el monto como un "pago tipo giftcard" en la venta.
//
// Para integrar al PaymentDialog: importar este componente y abrir cuando
// el cajero toca "Aplicar giftcard". Cuando onRedimida(resultado) dispara,
// agregar a la lista de pagos: { metodo: 'giftcard', monto: r.monto,
// referencia: r.giftcard }.

import { useState } from 'react';
import { toast } from 'sonner';
import { Gift, CheckCircle2, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { canjearGiftcard, type CanjeResultado } from '@/services/eventosGiftcardsService';
import { formatARS } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** ID de la venta — la RPC lo usa para auditar el canje. */
  ventaId?: number;
  /** Callback con el resultado para que el PaymentDialog lo aplique. */
  onRedimida: (r: CanjeResultado) => void;
}

export function GiftcardRedimirDialog({ open, onOpenChange, ventaId, onRedimida }: Props) {
  const [codigo, setCodigo] = useState('');
  const [validando, setValidando] = useState(false);
  const [resultado, setResultado] = useState<CanjeResultado | null>(null);

  async function validar() {
    const cod = codigo.trim().toUpperCase();
    if (!cod) { toast.error('Pegá el código de la giftcard'); return; }
    setValidando(true);
    const { data, error } = await canjearGiftcard(cod, ventaId);
    setValidando(false);
    if (error) { toast.error(error); return; }
    if (!data?.ok) { toast.error('Giftcard no válida'); return; }
    setResultado(data);
    toast.success(`Giftcard de ${formatARS(data.monto)} aplicada`);
  }

  function confirmar() {
    if (!resultado) return;
    onRedimida(resultado);
    setCodigo('');
    setResultado(null);
    onOpenChange(false);
  }

  function cancelar() {
    setCodigo('');
    setResultado(null);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gift className="h-5 w-5 text-brand-500" /> Aplicar giftcard
          </DialogTitle>
          <DialogDescription>
            Pegá el código de la giftcard para descontar su saldo del total de la venta.
          </DialogDescription>
        </DialogHeader>

        {!resultado ? (
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Código</Label>
              <Input
                value={codigo}
                onChange={(e) => setCodigo(e.target.value.toUpperCase())}
                placeholder="GIFT-2026-ABC123"
                className="font-mono"
                autoFocus
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={cancelar}>Cancelar</Button>
              <Button onClick={() => void validar()} disabled={validando}>
                {validando ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Validando…</> : 'Validar'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 pt-2">
            <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 space-y-1">
              <div className="flex items-center gap-2 text-emerald-700 font-medium">
                <CheckCircle2 className="h-5 w-5" /> Giftcard válida
              </div>
              <div className="text-sm">Monto: <span className="font-semibold">{formatARS(resultado.monto)}</span></div>
              <div className="text-xs text-ink-muted">De {resultado.comprador}{resultado.para ? ` para ${resultado.para}` : ''}</div>
              {resultado.mensaje && <div className="text-xs italic mt-1">"{resultado.mensaje}"</div>}
            </div>
            <p className="text-xs text-ink-muted">
              Esta giftcard se va a marcar como canjeada y se aplicará como pago en la venta.
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={cancelar}>Cancelar</Button>
              <Button onClick={confirmar}>Aplicar a la venta</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
