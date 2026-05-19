import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CurrencyInput } from '@/components/CurrencyInput';
import { createInsumo, updateInsumo } from '@/services/insumosService';
import type { Insumo, UnidadInsumo } from '@/types/database';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  insumo: Insumo | null;
  tenantId: string;
  onSaved: () => void;
}

const UNIDADES: { value: UnidadInsumo; label: string }[] = [
  { value: 'kg', label: 'Kilogramos (kg)' },
  { value: 'g', label: 'Gramos (g)' },
  { value: 'L', label: 'Litros (L)' },
  { value: 'ml', label: 'Mililitros (ml)' },
  { value: 'un', label: 'Unidades (un)' },
  { value: 'porcion', label: 'Porciones (porcion)' },
];

interface FormState {
  nombre: string;
  emoji: string;
  descripcion: string;
  unidad: UnidadInsumo;
  costo_actual: number;
  es_comprado: boolean;
}

const EMPTY: FormState = {
  nombre: '', emoji: '', descripcion: '', unidad: 'kg', costo_actual: 0, es_comprado: true,
};

export function InsumoEditorDialog({ open, onOpenChange, insumo, tenantId, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setForm(insumo ? {
        nombre: insumo.nombre,
        emoji: insumo.emoji ?? '',
        descripcion: insumo.descripcion ?? '',
        unidad: insumo.unidad,
        costo_actual: Number(insumo.costo_actual ?? 0),
        es_comprado: insumo.es_comprado,
      } : EMPTY);
    }
  }, [open, insumo]);

  const setField = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (savingRef.current) return;
    if (!form.nombre.trim()) { toast.error('El nombre es obligatorio'); return; }
    savingRef.current = true;
    setSaving(true);
    try {
      const payload = {
        nombre: form.nombre.trim(),
        emoji: form.emoji.trim() || null,
        descripcion: form.descripcion.trim() || null,
        unidad: form.unidad,
        costo_actual: form.costo_actual > 0 ? form.costo_actual : null,
        es_comprado: form.es_comprado,
      };
      const r = insumo
        ? await updateInsumo(insumo.id, payload)
        : await createInsumo(tenantId, payload);
      if (r.error) {
        if (r.error.toLowerCase().includes('uniq_insumo') || r.error.toLowerCase().includes('duplicate')) {
          toast.error(`Ya existe un insumo con nombre "${form.nombre}"`);
        } else {
          toast.error(r.error);
        }
        return;
      }
      toast.success(insumo ? 'Insumo actualizado' : 'Insumo creado');
      onSaved();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 shrink-0">
          <DialogTitle>{insumo ? 'Editar insumo' : 'Nuevo insumo'}</DialogTitle>
          <DialogDescription>
            {insumo
              ? 'Modificar nombre, unidad, costo o emoji. El nombre es identificador único por local.'
              : 'Crear ingrediente nuevo. La unidad es importante — todas las recetas que usen este insumo deben matcheaarla.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-1">
            <Label htmlFor="nombre">Nombre *</Label>
            <Input id="nombre" value={form.nombre} onChange={(e) => setField('nombre', e.target.value)} placeholder="Tomate cherry" />
          </div>
          <div>
            <Label htmlFor="emoji">Emoji (opcional)</Label>
            <Input id="emoji" value={form.emoji} onChange={(e) => setField('emoji', e.target.value)} placeholder="🍅" maxLength={2} />
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="descripcion">Descripción</Label>
            <Input id="descripcion" value={form.descripcion} onChange={(e) => setField('descripcion', e.target.value)} placeholder="Variedad usada para ensaladas" />
          </div>

          <div>
            <Label htmlFor="unidad">Unidad *</Label>
            <Select value={form.unidad} onValueChange={(v) => setField('unidad', v as UnidadInsumo)}>
              <SelectTrigger id="unidad"><SelectValue /></SelectTrigger>
              <SelectContent>
                {UNIDADES.map(u => <SelectItem key={u.value} value={u.value}>{u.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="costo_actual">Costo por unidad (opcional)</Label>
            <CurrencyInput
              value={form.costo_actual}
              onChange={(v) => setField('costo_actual', v)}
              currencySymbol="$"
              allowNegative={false}
            />
            <p className="text-xs text-muted-foreground mt-0.5">
              Lo podés cargar manual o esperar a que Fase 1.2 PASE lo llene desde facturas.
            </p>
          </div>

          <label className="flex items-center gap-2 cursor-pointer sm:col-span-2">
            <Switch checked={form.es_comprado} onCheckedChange={(v) => setField('es_comprado', v)} />
            <span className="text-sm">Se compra a proveedor</span>
            <span className="text-xs text-muted-foreground ml-2">
              (desmarcar si es subreceta producida internamente)
            </span>
          </label>
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || !form.nombre.trim()}>
            {saving ? 'Guardando…' : insumo ? 'Guardar' : 'Crear'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
