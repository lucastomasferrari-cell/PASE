import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { CurrencyInput } from '@/components/CurrencyInput';
import { getComboConSlots, setComboComponentes, type ComponenteFlat } from '@/services/combosService';
import type { Item } from '@/types/database';
import { formatARS } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Props {
  combo: Item;
  itemsDisponibles: Item[];
  tenantId: string;
  onClose: () => void;
  onSaved: () => void;
}

interface SlotLocal {
  nombre: string;
  min: number;
  max: number;
  opciones: Array<{ item_id: number; precio_extra: number }>;
}

// Editor de combo. Permite definir slots (Bebida, Postre, etc.) y para cada
// slot agregar items elegibles con precio extra opcional.
//
// Cuando se guarda, se reemplaza TODA la composición existente (soft-delete
// + insert). Es operación destructiva pero idempotente.

export function ComboEditorDialog({ combo, itemsDisponibles, tenantId, onClose, onSaved }: Props) {
  const [slots, setSlots] = useState<SlotLocal[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    getComboConSlots(combo.id).then(({ data, error }) => {
      if (error) toast.error(error);
      if (data) {
        setSlots(data.slots.map((s) => ({
          nombre: s.nombre,
          min: s.min,
          max: s.max,
          opciones: s.opciones.map((o) => ({ item_id: o.item_id, precio_extra: o.precio_extra })),
        })));
      }
      setLoading(false);
    });
  }, [combo.id]);

  function agregarSlot() {
    setSlots((arr) => [...arr, { nombre: `Slot ${arr.length + 1}`, min: 1, max: 1, opciones: [] }]);
  }

  function actualizarSlot(idx: number, patch: Partial<SlotLocal>) {
    setSlots((arr) => arr.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  function eliminarSlot(idx: number) {
    setSlots((arr) => arr.filter((_, i) => i !== idx));
  }

  function agregarOpcion(slotIdx: number, itemId: number) {
    setSlots((arr) => arr.map((s, i) => {
      if (i !== slotIdx) return s;
      if (s.opciones.some((o) => o.item_id === itemId)) return s; // ya está
      return { ...s, opciones: [...s.opciones, { item_id: itemId, precio_extra: 0 }] };
    }));
  }

  function actualizarOpcion(slotIdx: number, itemId: number, precioExtra: number) {
    setSlots((arr) => arr.map((s, i) => {
      if (i !== slotIdx) return s;
      return { ...s, opciones: s.opciones.map((o) => o.item_id === itemId ? { ...o, precio_extra: precioExtra } : o) };
    }));
  }

  function eliminarOpcion(slotIdx: number, itemId: number) {
    setSlots((arr) => arr.map((s, i) => {
      if (i !== slotIdx) return s;
      return { ...s, opciones: s.opciones.filter((o) => o.item_id !== itemId) };
    }));
  }

  async function guardar() {
    // Validación: cada slot tiene nombre + min/max coherentes + al menos 1 opción
    for (const s of slots) {
      if (!s.nombre.trim()) { toast.error('Hay un slot sin nombre'); return; }
      if (s.max < s.min) { toast.error(`Slot "${s.nombre}": max < min`); return; }
      if (s.opciones.length === 0) { toast.error(`Slot "${s.nombre}": agregá al menos 1 opción`); return; }
    }
    // Flatten para el servicio
    const flat: ComponenteFlat[] = [];
    slots.forEach((s, idx) => {
      for (const op of s.opciones) {
        flat.push({
          slot_nombre: s.nombre.trim(),
          slot_orden: idx,
          min_seleccion: s.min,
          max_seleccion: s.max,
          item_elegible_id: op.item_id,
          precio_extra: op.precio_extra,
        });
      }
    });
    setSaving(true);
    const { error } = await setComboComponentes(tenantId, combo.id, flat);
    setSaving(false);
    if (error) { toast.error(error); return; }
    toast.success('Combo guardado');
    onSaved();
  }

  function moverSlot(idx: number, dir: -1 | 1) {
    setSlots((arr) => {
      const next = [...arr];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return arr;
      const a = next[idx];
      const b = next[target];
      if (!a || !b) return arr;
      next[idx] = b;
      next[target] = a;
      return next;
    });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 shrink-0">
          <DialogTitle>
            {combo.emoji && <span className="mr-2">{combo.emoji}</span>}
            Configurar combo: {combo.nombre}
          </DialogTitle>
          <DialogDescription>
            Precio base: <strong>{formatARS(combo.precio_madre)}</strong>.
            Agregá slots (categorías) y dentro de cada uno las opciones que el cliente puede elegir.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-h-0">
          {loading ? (
            <div className="py-8 text-center text-muted-foreground">Cargando…</div>
          ) : (
            <>
              {slots.length === 0 && (
                <div className="py-8 text-center text-sm text-muted-foreground border-2 border-dashed rounded-md">
                  Sin slots. Tocá "Agregar slot" para empezar.
                </div>
              )}

              {slots.map((slot, idx) => (
                <SlotCard
                  key={idx}
                  slot={slot}
                  itemsDisponibles={itemsDisponibles}
                  onUpdate={(patch) => actualizarSlot(idx, patch)}
                  onRemove={() => eliminarSlot(idx)}
                  onAgregarOpcion={(itemId) => agregarOpcion(idx, itemId)}
                  onActualizarOpcion={(itemId, precio) => actualizarOpcion(idx, itemId, precio)}
                  onEliminarOpcion={(itemId) => eliminarOpcion(idx, itemId)}
                  onMover={(dir) => moverSlot(idx, dir)}
                  esPrimero={idx === 0}
                  esUltimo={idx === slots.length - 1}
                />
              ))}

              <Button variant="outline" onClick={agregarSlot} className="w-full">
                <Plus className="h-4 w-4 mr-1.5" />
                Agregar slot
              </Button>
            </>
          )}
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={guardar} disabled={saving || loading}>
            {saving ? 'Guardando…' : 'Guardar combo'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SlotCard({
  slot, itemsDisponibles, onUpdate, onRemove, onAgregarOpcion, onActualizarOpcion, onEliminarOpcion,
  onMover, esPrimero, esUltimo,
}: {
  slot: SlotLocal;
  itemsDisponibles: Item[];
  onUpdate: (patch: Partial<SlotLocal>) => void;
  onRemove: () => void;
  onAgregarOpcion: (itemId: number) => void;
  onActualizarOpcion: (itemId: number, precio: number) => void;
  onEliminarOpcion: (itemId: number) => void;
  onMover: (dir: -1 | 1) => void;
  esPrimero: boolean;
  esUltimo: boolean;
}) {
  const [itemAAgregar, setItemAAgregar] = useState<string>('');
  const itemsLibres = itemsDisponibles.filter((it) => !slot.opciones.some((o) => o.item_id === it.id));

  return (
    <div className="border-2 border-border rounded-lg p-3 space-y-3 bg-card">
      <div className="flex items-center gap-2">
        <div className="flex flex-col">
          <button
            type="button"
            onClick={() => onMover(-1)}
            disabled={esPrimero}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30 text-xs leading-none"
            aria-label="Subir"
          >▲</button>
          <button
            type="button"
            onClick={() => onMover(1)}
            disabled={esUltimo}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30 text-xs leading-none"
            aria-label="Bajar"
          >▼</button>
        </div>
        <GripVertical className="h-4 w-4 text-muted-foreground" />
        <Input
          value={slot.nombre}
          onChange={(e) => onUpdate({ nombre: e.target.value })}
          placeholder="Nombre del slot (ej: Bebida)"
          className="flex-1 h-9 font-medium"
        />
        <div className="flex items-center gap-1">
          <Label className="text-xs text-muted-foreground">Min</Label>
          <Input
            type="number"
            min={0}
            max={20}
            value={slot.min}
            onChange={(e) => onUpdate({ min: Number(e.target.value) || 0 })}
            className="w-14 h-9 text-center tabular-nums"
          />
        </div>
        <div className="flex items-center gap-1">
          <Label className="text-xs text-muted-foreground">Max</Label>
          <Input
            type="number"
            min={1}
            max={20}
            value={slot.max}
            onChange={(e) => onUpdate({ max: Number(e.target.value) || 1 })}
            className="w-14 h-9 text-center tabular-nums"
          />
        </div>
        <Button variant="ghost" size="sm" onClick={onRemove} className="text-destructive h-9 w-9 p-0">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Opciones del slot */}
      {slot.opciones.length > 0 && (
        <div className="space-y-1 border-l-2 border-primary/30 pl-3">
          {slot.opciones.map((op) => {
            const item = itemsDisponibles.find((i) => i.id === op.item_id);
            return (
              <div key={op.item_id} className={cn('flex items-center gap-2 py-1', !item && 'opacity-50')}>
                <span className="text-sm flex-1 truncate">
                  {item?.emoji ?? '📦'} {item?.nombre ?? `Item #${op.item_id}`}
                  {item && <span className="text-xs text-muted-foreground ml-2">base {formatARS(item.precio_madre)}</span>}
                </span>
                <div className="flex items-center gap-1">
                  <Label className="text-xs text-muted-foreground">Extra</Label>
                  <div className="w-28">
                    <CurrencyInput
                      value={op.precio_extra}
                      onChange={(v) => onActualizarOpcion(op.item_id, v)}
                    />
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => onEliminarOpcion(op.item_id)} className="text-destructive h-8 w-8 p-0">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {/* Agregar opción */}
      {itemsLibres.length > 0 && (
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <Label className="text-xs text-muted-foreground">Agregar opción al slot</Label>
            <Select value={itemAAgregar} onValueChange={setItemAAgregar}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Elegir item…" /></SelectTrigger>
              <SelectContent className="max-h-72">
                {itemsLibres.map((it) => (
                  <SelectItem key={it.id} value={String(it.id)}>
                    {it.emoji ?? ''} {it.nombre} · {formatARS(it.precio_madre)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            disabled={!itemAAgregar}
            onClick={() => {
              if (itemAAgregar) {
                onAgregarOpcion(Number(itemAAgregar));
                setItemAAgregar('');
              }
            }}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
