import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { listMetodosCobroActivos } from '@/services/configService';
import { cambiarMedioPago } from '@/services/ventasService';
import { formatARS } from '@/lib/format';
import type { MetodoCobro } from '@/types/database';
import { ManagerOverrideDialog } from './ManagerOverrideDialog';

export interface PagoEditable { id: number; metodo: string; monto: number }

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ventaNumero: number | string;
  localId: number;
  /** Pagos CONFIRMADOS de la venta. */
  pagos: PagoEditable[];
  onDone: () => void;
}

// Corregir el medio de pago de una venta ya cobrada (por si el cajero eligió
// uno equivocado). Requiere PIN de manager (ManagerOverrideDialog). El backend
// solo lo permite con el turno abierto y reclasifica la caja en la misma txn.
export function CambiarMedioPagoDialog({ open, onOpenChange, ventaNumero, localId, pagos, onDone }: Props) {
  const [metodos, setMetodos] = useState<MetodoCobro[]>([]);
  // pagoId → slug nuevo elegido
  const [sel, setSel] = useState<Record<number, string>>({});
  const [pinOpen, setPinOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSel({});
    setPinOpen(false);
    listMetodosCobroActivos(localId).then((r) => setMetodos(r.data));
  }, [open, localId]);

  const nombreDe = useMemo(() => {
    const m = new Map(metodos.map((x) => [x.slug, x.nombre] as const));
    return (slug: string) => m.get(slug) ?? slug;
  }, [metodos]);

  // Solo los pagos cuyo medio cambió respecto al actual.
  const cambios = useMemo(
    () => pagos.filter((p) => sel[p.id] && sel[p.id] !== p.metodo),
    [pagos, sel],
  );

  async function aplicar(managerId: string) {
    let hechos = 0;
    for (const p of cambios) {
      const { error } = await cambiarMedioPago(p.id, sel[p.id]!, managerId);
      if (error) { toast.error(error); return; }
      hechos++;
    }
    if (hechos > 0) toast.success(hechos === 1 ? 'Medio de pago corregido' : `${hechos} medios corregidos`);
    onDone();
    onOpenChange(false);
  }

  return (
    <>
      <Dialog open={open && !pinOpen} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Corregir medio de pago</DialogTitle>
            <DialogDescription>
              Venta #{ventaNumero}. Cambialo si se cobró con un medio equivocado.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {pagos.length === 0 && (
              <p className="text-sm text-muted-foreground">No hay pagos confirmados para corregir.</p>
            )}
            {pagos.map((p) => (
              <div key={p.id} className="space-y-1.5 rounded-md border border-border p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    Actual: <b className="text-foreground">{nombreDe(p.metodo)}</b>
                  </span>
                  <span className="tabular-nums font-medium">{formatARS(p.monto)}</span>
                </div>
                <Label className="text-xs text-muted-foreground">Nuevo medio</Label>
                <Select
                  value={sel[p.id] ?? p.metodo}
                  onValueChange={(v) => setSel((s) => ({ ...s, [p.id]: v }))}
                >
                  <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {metodos.map((m) => (
                      <SelectItem key={m.slug} value={m.slug}>
                        {m.emoji ? `${m.emoji} ` : ''}{m.nombre}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button disabled={cambios.length === 0} onClick={() => setPinOpen(true)}>
              Continuar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManagerOverrideDialog
        open={pinOpen}
        onOpenChange={setPinOpen}
        accion="Corregir medio de pago"
        descripcion={cambios
          .map((p) => `${nombreDe(p.metodo)} → ${nombreDe(sel[p.id]!)} (${formatARS(p.monto)})`)
          .join(' · ')}
        onAuthorized={async ({ managerId }) => { await aplicar(managerId); }}
      />
    </>
  );
}
