import { useEffect, useState, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { partirCuentaService } from '@/services/mesasService';
import { listVentasItems } from '@/services/ventasService';
import { listItems, type ItemConGrupo } from '@/services/itemsService';
import type { VentaPosItem } from '@/types/database';
import { ManagerOverrideDialog } from './ManagerOverrideDialog';
import { formatARS } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ventaId: number;
  tenantId: string;
  onPartida: (nuevaVentaId: number) => void;
}

// Versión simple: checkboxes para mover items a una nueva venta hermana.
// Drag & drop / múltiples cuentas (3+) postergado a otro sprint.
export function SplitCheckDialog({ open, onOpenChange, ventaId, tenantId, onPartida }: Props) {
  const [items, setItems] = useState<VentaPosItem[]>([]);
  const [catalogo, setCatalogo] = useState<ItemConGrupo[]>([]);
  const [loading, setLoading] = useState(true);
  const [seleccion, setSeleccion] = useState<Set<number>>(new Set());
  const [showOverride, setShowOverride] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSeleccion(new Set());
    setLoading(true);
    Promise.all([
      listVentasItems(ventaId),
      listItems({ tenantId }),
    ]).then(([itemsRes, catalogoRes]) => {
      setItems(itemsRes.data.filter((i) => i.estado !== 'anulado'));
      setCatalogo(catalogoRes.data);
      setLoading(false);
    });
  }, [open, ventaId, tenantId]);

  function toggle(id: number) {
    setSeleccion((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totales = useMemo(() => {
    let aMover = 0;
    let aDejar = 0;
    for (const it of items) {
      if (seleccion.has(it.id)) aMover += Number(it.subtotal);
      else aDejar += Number(it.subtotal);
    }
    return { aMover, aDejar };
  }, [items, seleccion]);

  function abrirOverride() {
    if (seleccion.size === 0) { toast.error('Elegí al menos 1 item para mover'); return; }
    if (seleccion.size === items.length) { toast.error('No podés mover todos los items'); return; }
    setShowOverride(true);
  }

  async function ejecutar({ managerId, motivo }: { managerId: string; motivo: string }) {
    const { ventaNuevaId, error } = await partirCuentaService(
      ventaId, Array.from(seleccion), managerId, motivo,
    );
    if (error || !ventaNuevaId) throw new Error(error ?? 'Error');
    toast.success('Cuenta partida');
    onPartida(ventaNuevaId);
  }

  function nombreItem(it: VentaPosItem): string {
    return catalogo.find((c) => c.id === it.item_id)?.nombre ?? `Item #${it.item_id}`;
  }

  return (
    <>
      <Dialog open={open && !showOverride} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Partir cuenta</DialogTitle>
            <DialogDescription>
              Marcá los items que se mueven a una venta nueva. Los demás se quedan en esta.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="py-8 text-center text-muted-foreground">Cargando…</div>
          ) : (
            <>
              <div className="border border-border rounded-md divide-y divide-border max-h-[40vh] overflow-y-auto">
                {items.map((it) => {
                  const sel = seleccion.has(it.id);
                  return (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => toggle(it.id)}
                      className={cn(
                        'w-full p-3 flex items-center gap-3 text-left transition-colors',
                        sel ? 'bg-primary/10' : 'hover:bg-muted',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={sel}
                        onChange={() => toggle(it.id)}
                        className="h-4 w-4"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {Number(it.cantidad)}× {nombreItem(it)}
                        </div>
                        <div className="text-xs text-muted-foreground">{it.estado}</div>
                      </div>
                      <strong className="tabular-nums text-sm">{formatARS(it.subtotal)}</strong>
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-md bg-muted p-2">
                  <Label className="text-xs text-muted-foreground">Se queda</Label>
                  <div className="text-base font-semibold tabular-nums">{formatARS(totales.aDejar)}</div>
                </div>
                <div className="rounded-md bg-primary/10 p-2">
                  <Label className="text-xs text-primary">Se mueve a nueva</Label>
                  <div className="text-base font-semibold tabular-nums">{formatARS(totales.aMover)}</div>
                </div>
              </div>
            </>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button onClick={abrirOverride} disabled={loading || seleccion.size === 0}>
              Continuar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManagerOverrideDialog
        open={showOverride}
        onOpenChange={(o) => { setShowOverride(o); if (!o) onOpenChange(false); }}
        accion="Partir cuenta"
        descripcion={`Mover ${seleccion.size} item(s) por ${formatARS(totales.aMover)} a una nueva venta hermana.`}
        onAuthorized={ejecutar}
      />
    </>
  );
}
