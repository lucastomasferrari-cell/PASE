import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { listMesasLibres, transferirMesaService } from '@/services/mesasService';
import { ManagerOverrideDialog } from './ManagerOverrideDialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ventaId: number;
  localId: number;
  mesaActualId: number | null;
  onTransferida: () => void;
}

export function TransferMesaDialog({ open, onOpenChange, ventaId, localId, mesaActualId, onTransferida }: Props) {
  const [mesas, setMesas] = useState<Array<{ id: number; numero: string; zona: string | null }>>([]);
  const [destinoId, setDestinoId] = useState<string>('');
  const [showOverride, setShowOverride] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDestinoId('');
    listMesasLibres(localId).then((r) => {
      setMesas(r.data.filter((m) => m.id !== mesaActualId));
    });
  }, [open, localId, mesaActualId]);

  function abrirOverride() {
    if (!destinoId) { toast.error('Elegí mesa destino'); return; }
    setShowOverride(true);
  }

  async function ejecutar({ managerId, motivo }: { managerId: string; motivo: string }) {
    const { error } = await transferirMesaService(ventaId, Number(destinoId), managerId, motivo);
    if (error) throw new Error(error);
    toast.success('Mesa transferida');
    onTransferida();
  }

  return (
    <>
      <Dialog open={open && !showOverride} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transferir a otra mesa</DialogTitle>
            <DialogDescription>La venta cambia de mesa. Las mesas libres aparecen en el selector.</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label>Mesa destino</Label>
            <Select value={destinoId} onValueChange={setDestinoId}>
              <SelectTrigger className="h-11"><SelectValue placeholder="Elegir mesa libre…" /></SelectTrigger>
              <SelectContent>
                {mesas.length === 0 && <SelectItem value="_none" disabled>No hay mesas libres</SelectItem>}
                {mesas.map((m) => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    Mesa {m.numero}{m.zona ? ` · ${m.zona}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button onClick={abrirOverride} disabled={!destinoId}>Continuar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManagerOverrideDialog
        open={showOverride}
        onOpenChange={(o) => { setShowOverride(o); if (!o) onOpenChange(false); }}
        accion="Transferir mesa"
        descripcion={`Mover la venta a la mesa ${mesas.find((m) => m.id === Number(destinoId))?.numero ?? '?'}.`}
        onAuthorized={ejecutar}
      />
    </>
  );
}
