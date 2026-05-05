import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { listVentas } from '@/services/ventasService';
import { unirMesasService } from '@/services/mesasService';
import { ManagerOverrideDialog } from './ManagerOverrideDialog';
import type { VentaPos } from '@/types/database';
import { formatARS } from '@/lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ventaDestinoId: number;     // venta a la que se va a juntar (la actual)
  localId: number;
  onUnida: () => void;
}

export function MergeMesasDialog({ open, onOpenChange, ventaDestinoId, localId, onUnida }: Props) {
  const [ventas, setVentas] = useState<VentaPos[]>([]);
  const [origenId, setOrigenId] = useState<string>('');
  const [showOverride, setShowOverride] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOrigenId('');
    listVentas({
      localId,
      modos: ['salon'],
      estados: ['abierta', 'enviada', 'lista'],
    }).then((r) => {
      setVentas(r.data.filter((v) => v.id !== ventaDestinoId && v.mesa_id !== null));
    });
  }, [open, localId, ventaDestinoId]);

  function abrirOverride() {
    if (!origenId) { toast.error('Elegí venta origen'); return; }
    setShowOverride(true);
  }

  async function ejecutar({ managerId, motivo }: { managerId: string; motivo: string }) {
    const { error } = await unirMesasService(Number(origenId), ventaDestinoId, managerId, motivo);
    if (error) throw new Error(error);
    toast.success('Mesas unidas');
    onUnida();
  }

  const origenSel = ventas.find((v) => v.id === Number(origenId));

  return (
    <>
      <Dialog open={open && !showOverride} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unir con otra mesa</DialogTitle>
            <DialogDescription>
              Los items de la mesa elegida van a pasar a esta venta. La mesa origen queda libre.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label>Mesa origen (sus items se transfieren acá)</Label>
            <Select value={origenId} onValueChange={setOrigenId}>
              <SelectTrigger className="h-11"><SelectValue placeholder="Elegir venta abierta…" /></SelectTrigger>
              <SelectContent>
                {ventas.length === 0 && <SelectItem value="_none" disabled>No hay otras mesas abiertas</SelectItem>}
                {ventas.map((v) => (
                  <SelectItem key={v.id} value={String(v.id)}>
                    Mesa {v.mesa_id ?? '?'} · {formatARS(v.total)} · #{v.numero_local}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button onClick={abrirOverride} disabled={!origenId}>Continuar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManagerOverrideDialog
        open={showOverride}
        onOpenChange={(o) => { setShowOverride(o); if (!o) onOpenChange(false); }}
        accion="Unir mesas"
        descripcion={`Mover items de venta #${origenSel?.numero_local ?? '?'} (${formatARS(origenSel?.total ?? 0)}) a esta venta. Mesa origen queda libre.`}
        onAuthorized={ejecutar}
      />
    </>
  );
}
