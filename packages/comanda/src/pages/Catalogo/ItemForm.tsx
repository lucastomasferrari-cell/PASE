import { useState, useEffect, useRef } from 'react';
import type { Usuario } from '../../types/auth';
import type { Item, ItemGrupo, TaxRate, Estacion } from '../../types/database';
import type { ItemDraft } from '../../services/itemsService';
import { createItem, updateItem } from '../../services/itemsService';
import type { MarcaLite } from '../../services/marcasService';
import { listTaxRates } from '../../services/taxRatesService';
import { recalcularAtadosDeItem } from '../../services/preciosService';
import { validarNombre, validarPrecio } from '../../lib/validate';
import { MoneyInput } from '../../components/MoneyInput';
import { EmojiPicker } from '../../components/EmojiPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

interface Props {
  user: Usuario;
  grupos: ItemGrupo[];
  marcas: MarcaLite[];
  /** Marca por defecto para items nuevos (la del filtro de la lista). */
  defaultMarcaId: number | null;
  /** Sucursal del alcance activo: null = menú maestro (local_id NULL);
   * un id = la copia de esa sucursal. Se graba al CREAR un item nuevo. */
  scopeLocalId: number | null;
  item: Item | null;
  onClose: () => void;
  onSaved: () => void;
}

const ESTACIONES: { value: Estacion | '_none'; label: string }[] = [
  { value: '_none',           label: '— heredar del grupo —' },
  { value: 'cocina_caliente', label: 'Cocina caliente' },
  { value: 'cocina_fria',     label: 'Cocina fría' },
  { value: 'barra',           label: 'Barra' },
  { value: 'postres',         label: 'Postres' },
];

export function ItemForm({ user, grupos, marcas, defaultMarcaId, scopeLocalId, item, onClose, onSaved }: Props) {
  const isEdit = item !== null;
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [marcaId, setMarcaId] = useState<number | null>(
    isEdit
      ? ((item as { marca_id?: number | null }).marca_id ?? null)
      : (defaultMarcaId ?? marcas[0]?.id ?? null),
  );
  const [nombre, setNombre] = useState(item?.nombre ?? '');
  const [descripcion, setDescripcion] = useState(item?.descripcion ?? '');
  const [emoji, setEmoji] = useState<string | null>(item?.emoji ?? null);
  const [codigo, setCodigo] = useState(item?.codigo ?? '');
  const [grupoId, setGrupoId] = useState<number | null>(item?.grupo_id ?? null);
  const [precio, setPrecio] = useState<number>(item?.precio_madre ?? 0);
  const [taxRateId, setTaxRateId] = useState<number | null>(item?.tax_rate_id ?? null);
  const [estacion, setEstacion] = useState<Estacion | ''>((item?.estacion as Estacion) ?? '');
  const [visiblePos, setVisiblePos] = useState(item?.visible_pos ?? true);
  const [visibleQr, setVisibleQr] = useState(item?.visible_qr ?? true);
  const [visibleTienda, setVisibleTienda] = useState(item?.visible_tienda ?? true);
  const [esCombo, setEsCombo] = useState(item?.es_combo ?? false);
  const [tiempoPrepMin, setTiempoPrepMin] = useState<number | ''>(item?.tiempo_prep_min ?? '');
  // SKU externos para partners (Rappi/PeYa/Deliverect). Opcionales — solo
  // se popular cuando el dueño integra con un partner.
  const [skuRappi, setSkuRappi] = useState((item as { sku_rappi?: string | null })?.sku_rappi ?? '');
  const [skuPedidosya, setSkuPedidosya] = useState((item as { sku_pedidosya?: string | null })?.sku_pedidosya ?? '');
  const [skuDeliverect, setSkuDeliverect] = useState((item as { sku_deliverect?: string | null })?.sku_deliverect ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    listTaxRates(user.tenant_id).then((res) => setTaxRates(res.data));
  }, [user.tenant_id]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    const eN = validarNombre(nombre);
    if (eN) { setError(eN); return; }
    const eP = validarPrecio(precio);
    if (eP) { setError(eP); return; }
    if (!user.tenant_id) {
      setError('Tu usuario no tiene tenant asignado. Contactá soporte.');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const draft: ItemDraft = {
        nombre: nombre.trim(),
        descripcion: descripcion.trim() || null,
        emoji,
        codigo: codigo.trim() || null,
        grupo_id: grupoId,
        precio_madre: precio,
        tax_rate_id: taxRateId,
        estacion: estacion || null,
        visible_pos: visiblePos,
        visible_qr: visibleQr,
        visible_tienda: visibleTienda,
        es_combo: esCombo,
        tiempo_prep_min: typeof tiempoPrepMin === 'number' && tiempoPrepMin > 0 ? tiempoPrepMin : null,
        tenant_id: user.tenant_id,
        // Nuevo → local_id del alcance (maestro=null | sucursal=id).
        // Edición → preservar el local_id del item (no moverlo de alcance).
        local_id: isEdit && item ? item.local_id : scopeLocalId,
        marca_id: marcaId,
        // SKU externos para partners — null si vacío para no inflar la fila
        sku_rappi: skuRappi.trim() || null,
        sku_pedidosya: skuPedidosya.trim() || null,
        sku_deliverect: skuDeliverect.trim() || null,
      };

      if (isEdit && item) {
        const precioCambio = item.precio_madre !== precio;
        const { error: err } = await updateItem(item.id, draft);
        if (err) { setError(err); return; }
        if (precioCambio) {
          await recalcularAtadosDeItem(item.id);
        }
      } else {
        const { error: err } = await createItem(draft);
        if (err) { setError(err); return; }
      }
      onSaved();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] p-0 gap-0 flex flex-col">
        <form onSubmit={onSubmit} className="flex flex-col min-h-0 flex-1">
        <DialogHeader className="px-6 pt-6 shrink-0">
          <DialogTitle>{isEdit ? 'Editar item' : 'Nuevo item'}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-h-0">
          <div className="space-y-2">
            <Label>Emoji</Label>
            <EmojiPicker value={emoji} onChange={setEmoji} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="nombre">Nombre *</Label>
            <Input
              id="nombre"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              required
              autoFocus
              className="h-11"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="descripcion">Descripción</Label>
            <Textarea
              id="descripcion"
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              rows={2}
            />
          </div>

          {marcas.length > 0 && (
            <div className="space-y-2">
              <Label>Marca</Label>
              <Select
                value={marcaId === null ? '_shared' : String(marcaId)}
                onValueChange={(v) => setMarcaId(v === '_shared' ? null : Number(v))}
              >
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {marcas.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>{m.nombre}</SelectItem>
                  ))}
                  <SelectItem value="_shared">Compartido (todas las marcas)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="codigo">Código interno</Label>
              <Input
                id="codigo"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label>Grupo</Label>
              <Select
                value={grupoId === null ? '_none' : String(grupoId)}
                onValueChange={(v) => setGrupoId(v === '_none' ? null : Number(v))}
              >
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">— sin grupo —</SelectItem>
                  {grupos.map((g) => (
                    <SelectItem key={g.id} value={String(g.id)}>
                      {g.emoji ?? ''} {g.nombre}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Precio madre *</Label>
              <MoneyInput value={precio} onChange={setPrecio} />
            </div>
            <div className="space-y-2">
              <Label>Tax rate</Label>
              <Select
                value={taxRateId === null ? '_none' : String(taxRateId)}
                onValueChange={(v) => setTaxRateId(v === '_none' ? null : Number(v))}
              >
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">— heredar del grupo —</SelectItem>
                  {taxRates.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.nombre} ({t.porcentaje}%)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Estación cocina</Label>
              <Select
                value={estacion === '' ? '_none' : estacion}
                onValueChange={(v) => setEstacion(v === '_none' ? '' : (v as Estacion))}
              >
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ESTACIONES.map((est) => (
                    <SelectItem key={est.value} value={est.value}>
                      {est.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="prep">Tiempo prep (min)</Label>
              <input
                id="prep"
                type="number"
                min={0}
                max={180}
                value={tiempoPrepMin}
                onChange={(e) => {
                  const v = e.target.value;
                  setTiempoPrepMin(v === '' ? '' : Number(v));
                }}
                placeholder="opcional"
                className="w-full h-11 px-3 rounded-md border border-input bg-background text-sm tabular-nums"
              />
              <p className="text-xs text-muted-foreground">
                Mozo le dice al cliente "tarda ~Xmin". Suma al tiempo estimado de la mesa.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <Label>Visibilidad por canal</Label>
            <VisibilityToggle label="POS" checked={visiblePos} onCheckedChange={setVisiblePos} />
            <VisibilityToggle label="QR" checked={visibleQr} onCheckedChange={setVisibleQr} />
            <VisibilityToggle label="Tienda online" checked={visibleTienda} onCheckedChange={setVisibleTienda} />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <Label className="cursor-pointer">Es combo</Label>
              <p className="text-xs text-muted-foreground">
                La UI de componentes va en sprint siguiente
              </p>
            </div>
            <Switch checked={esCombo} onCheckedChange={setEsCombo} />
          </div>

          {/* SKU externos — opcionales, solo si el item se sincroniza con
              partners de delivery. Si no tenés integración, dejá vacío. */}
          <details className="rounded-md border border-border p-3 group">
            <summary className="cursor-pointer text-sm font-medium select-none">
              SKU en partners de delivery (opcional)
              <span className="text-xs font-normal text-muted-foreground ml-2 group-open:hidden">
                — solo si vendés por Rappi/PedidosYa/Deliverect
              </span>
            </summary>
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                Si vendés este item por una plataforma externa, ellos le asignan su
                propio ID. Cargalo acá para que los pedidos que lleguen por webhook
                se mapeen al item correcto. Sino dejá vacío y se usa el ID interno.
              </p>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">SKU Rappi</Label>
                  <input
                    value={skuRappi}
                    onChange={(e) => setSkuRappi(e.target.value)}
                    placeholder="ej: rappi_12345"
                    className="w-full h-10 px-3 rounded-md border border-input bg-background text-xs font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">SKU PedidosYa</Label>
                  <input
                    value={skuPedidosya}
                    onChange={(e) => setSkuPedidosya(e.target.value)}
                    placeholder="ej: peya_xyz"
                    className="w-full h-10 px-3 rounded-md border border-input bg-background text-xs font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">SKU Deliverect</Label>
                  <input
                    value={skuDeliverect}
                    onChange={(e) => setSkuDeliverect(e.target.value)}
                    placeholder="ej: dlv_abc"
                    className="w-full h-10 px-3 rounded-md border border-input bg-background text-xs font-mono"
                  />
                </div>
              </div>
            </div>
          </details>

          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
          )}
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Guardando…' : isEdit ? 'Guardar' : 'Crear'}
          </Button>
        </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VisibilityToggle({
  label, checked, onCheckedChange,
}: { label: string; checked: boolean; onCheckedChange: (b: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border p-3">
      <Label className="cursor-pointer">{label}</Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
