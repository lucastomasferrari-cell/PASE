import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Download, Loader2 } from 'lucide-react';
import { importarMenuMarca } from '@/services/itemsService';
import { listLocalesAccesibles, type LocalSimple } from '@/services/configService';
import type { MarcaLite } from '@/services/marcasService';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  marcas: MarcaLite[];
  /** Se llama tras un import OK, por si la vista quiere refrescar. */
  onImported?: () => void;
}

type Modo = 'reemplazar' | 'novedades';

/**
 * Importar menú de la marca → una sucursal.
 * El maestro (items/grupos sin sucursal) se copia a la sucursal elegida.
 * modo 'reemplazar' pisa lo que tenga; 'novedades' solo agrega lo que falta.
 */
export function ImportarMenuDialog({ open, onOpenChange, marcas, onImported }: Props) {
  const [locales, setLocales] = useState<LocalSimple[]>([]);
  const [localId, setLocalId] = useState<string>('');
  const [modo, setModo] = useState<Modo>('reemplazar');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    listLocalesAccesibles().then((r) => setLocales(r.data));
  }, [open]);

  const marcaNombre = (id: number | null | undefined) =>
    id == null ? null : (marcas.find((m) => m.id === id)?.nombre ?? null);

  async function handleImport() {
    if (!localId) return;
    setBusy(true);
    const { data, error } = await importarMenuMarca(Number(localId), modo);
    setBusy(false);
    if (error) { toast.error(error); return; }
    toast.success(
      `Menú importado: ${data?.items ?? 0} items, ${data?.grupos ?? 0} grupos${
        modo === 'novedades' ? ' (solo novedades)' : ''
      }.`,
    );
    onImported?.();
    onOpenChange(false);
    setLocalId('');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Importar menú a una sucursal</DialogTitle>
          <DialogDescription>
            Copia el menú maestro de la marca a la sucursal elegida. Después cada
            sucursal puede editar su propia copia sin tocar el maestro.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Sucursal destino</label>
            <Select value={localId} onValueChange={setLocalId}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Elegí una sucursal…" />
              </SelectTrigger>
              <SelectContent>
                {locales.map((l) => {
                  const m = marcaNombre(l.marca_id);
                  return (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.nombre}{m ? ` · ${m}` : ''}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Se importa el menú maestro de la marca de esa sucursal.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Modo</label>
            <Select value={modo} onValueChange={(v) => setModo(v as Modo)}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reemplazar">Reemplazar todo</SelectItem>
                <SelectItem value="novedades">Solo agregar novedades</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {modo === 'reemplazar'
                ? 'Borra el menú actual de la sucursal y copia el maestro completo.'
                : 'Agrega solo los items del maestro que la sucursal todavía no tiene (por nombre).'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={handleImport} disabled={!localId || busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
            Importar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
