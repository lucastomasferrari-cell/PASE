import { useState, useEffect } from 'react';
import type { Usuario } from '../../types/auth';
import type { Item, ItemGrupo, TaxRate, Estacion } from '../../types/database';
import type { ItemDraft } from '../../services/itemsService';
import { createItem, updateItem } from '../../services/itemsService';
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

export function ItemForm({ user, grupos, item, onClose, onSaved }: Props) {
  const isEdit = item !== null;
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
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
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listTaxRates(user.tenant_id).then((res) => setTaxRates(res.data));
  }, [user.tenant_id]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const eN = validarNombre(nombre);
    if (eN) { setError(eN); return; }
    const eP = validarPrecio(precio);
    if (eP) { setError(eP); return; }
    if (!user.tenant_id) {
      setError('Tu usuario no tiene tenant asignado. Contactá soporte.');
      return;
    }
    setSaving(true);
    setError(null);

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
      tenant_id: user.tenant_id,
      local_id: null,
    };

    if (isEdit && item) {
      const precioCambio = item.precio_madre !== precio;
      const { error: err } = await updateItem(item.id, draft);
      if (err) { setError(err); setSaving(false); return; }
      if (precioCambio) {
        await recalcularAtadosDeItem(item.id);
      }
    } else {
      const { error: err } = await createItem(draft);
      if (err) { setError(err); setSaving(false); return; }
    }
    setSaving(false);
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Editar item' : 'Nuevo item'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
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

          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
          )}

          <DialogFooter>
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
