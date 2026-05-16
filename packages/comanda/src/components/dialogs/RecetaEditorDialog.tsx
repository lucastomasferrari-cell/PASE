import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Trash2, Plus } from 'lucide-react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  upsertReceta, getRecetaPorItem,
  type RecetaInsumoInput,
} from '@/services/recetasService';
import { listInsumos } from '@/services/insumosService';
import type { Insumo } from '@/types/database';
import { formatARS } from '@/lib/format';
import type { ItemConReceta } from '@/services/recetasService';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ItemConReceta | null;
  tenantId: string;
  onSaved: () => void;
}

interface InsumoLinea {
  insumo_id: number | null;
  cantidad: number;
  merma_pct: number;
  notas: string;
}

export function RecetaEditorDialog({ open, onOpenChange, item, tenantId, onSaved }: Props) {
  const [nombre, setNombre] = useState('');
  const [rendimiento, setRendimiento] = useState(1);
  const [notas, setNotas] = useState('');
  const [lineas, setLineas] = useState<InsumoLinea[]>([]);
  const [insumosDisponibles, setInsumosDisponibles] = useState<Insumo[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !item) return;
    setLoading(true);
    void Promise.all([
      listInsumos(),
      getRecetaPorItem(item.id),
    ]).then(([insumosRes, recetaRes]) => {
      setInsumosDisponibles(insumosRes.data);
      if (recetaRes.data) {
        setNombre(recetaRes.data.nombre);
        setRendimiento(Number(recetaRes.data.rendimiento));
        setNotas(recetaRes.data.notas ?? '');
        setLineas(recetaRes.data.insumos.map(ri => ({
          insumo_id: ri.insumo_id,
          cantidad: Number(ri.cantidad),
          merma_pct: Number(ri.merma_pct),
          notas: ri.notas ?? '',
        })));
      } else {
        // Receta nueva — pre-poblar con el nombre del item.
        setNombre(`Receta ${item.nombre}`);
        setRendimiento(1);
        setNotas('');
        setLineas([]);
      }
      setLoading(false);
    });
  }, [open, item]);

  const agregarLinea = () => {
    setLineas([...lineas, { insumo_id: null, cantidad: 0, merma_pct: 0, notas: '' }]);
  };
  const eliminarLinea = (idx: number) => {
    setLineas(lineas.filter((_, i) => i !== idx));
  };
  const updateLinea = (idx: number, patch: Partial<InsumoLinea>) => {
    setLineas(lineas.map((l, i) => i === idx ? { ...l, ...patch } : l));
  };

  // Cálculo del costo por porción en tiempo real.
  const costoPorPorcion = (() => {
    if (rendimiento <= 0) return null;
    let total = 0;
    let allHaveCost = true;
    for (const l of lineas) {
      if (l.insumo_id == null) continue;
      const insumo = insumosDisponibles.find(i => i.id === l.insumo_id);
      if (!insumo || insumo.costo_actual == null) { allHaveCost = false; break; }
      total += Number(insumo.costo_actual) * l.cantidad * (1 + l.merma_pct / 100);
    }
    return allHaveCost ? total / rendimiento : null;
  })();

  const handleSave = async () => {
    if (!item) return;
    if (!nombre.trim()) { toast.error('El nombre de la receta es obligatorio'); return; }
    if (rendimiento <= 0) { toast.error('El rendimiento debe ser > 0'); return; }
    const lineasFilled = lineas.filter(l => l.insumo_id != null && l.cantidad > 0);
    if (lineasFilled.length === 0) {
      if (!confirm('Vas a guardar una receta sin insumos. ¿Continuar?')) return;
    }
    setSaving(true);
    const insumos: RecetaInsumoInput[] = lineasFilled.map((l, idx) => ({
      insumo_id: l.insumo_id!,
      cantidad: l.cantidad,
      merma_pct: l.merma_pct,
      notas: l.notas.trim() || null,
      orden: idx,
    }));
    const r = await upsertReceta({
      itemId: item.id, tenantId, localId: null,
      nombre: nombre.trim(),
      rendimiento,
      notas: notas.trim() || null,
      insumos,
    });
    setSaving(false);
    if (r.error) { toast.error(r.error); return; }
    toast.success('Receta guardada');
    onSaved();
  };

  if (!item) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 shrink-0">
          <DialogTitle>
            {item.emoji && <span className="mr-2">{item.emoji}</span>}
            Receta de {item.nombre}
          </DialogTitle>
          <DialogDescription>
            Precio del item: <strong>{formatARS(item.precio_madre)}</strong>.
            {costoPorPorcion != null ? (
              <> Costo estimado por porción: <strong>{formatARS(costoPorPorcion)}</strong> — Margen: <strong>{formatARS(item.precio_madre - costoPorPorcion)}</strong> ({((1 - costoPorPorcion / item.precio_madre) * 100).toFixed(1)}%)</>
            ) : (
              <> Costo no calculable — algún insumo no tiene costo cargado.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
        {loading ? (
          <div className="py-8 text-center text-muted-foreground">Cargando…</div>
        ) : (
          <div className="space-y-4">
            {/* Cabeza receta */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <Label htmlFor="nombre">Nombre de la receta *</Label>
                <Input id="nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Receta hamburguesa cheddar" />
              </div>
              <div>
                <Label htmlFor="rendimiento">Rendimiento (porciones) *</Label>
                <Input
                  id="rendimiento" type="number" min="0.1" step="0.1"
                  value={rendimiento}
                  onChange={(e) => setRendimiento(Number(e.target.value) || 0)}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="notas">Notas (opcional)</Label>
              <Input id="notas" value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Tiempo de cocción, técnicas, etc." />
            </div>

            {/* Insumos */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Insumos</Label>
                <Button variant="outline" size="sm" onClick={agregarLinea}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Agregar insumo
                </Button>
              </div>

              {lineas.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground border rounded-md">
                  Sin insumos cargados. Tocá "Agregar insumo" para empezar.
                </div>
              ) : (
                <div className="border rounded-md divide-y">
                  {lineas.map((l, idx) => {
                    const insumo = insumosDisponibles.find(i => i.id === l.insumo_id);
                    const subtotal = insumo?.costo_actual != null
                      ? Number(insumo.costo_actual) * l.cantidad * (1 + l.merma_pct / 100)
                      : null;
                    return (
                      <div key={idx} className="p-3 grid grid-cols-12 gap-2 items-end">
                        <div className="col-span-5">
                          <Label className="text-xs text-muted-foreground">Insumo</Label>
                          <Select
                            value={l.insumo_id != null ? String(l.insumo_id) : ''}
                            onValueChange={(v) => updateLinea(idx, { insumo_id: Number(v) })}
                          >
                            <SelectTrigger><SelectValue placeholder="Elegí un insumo" /></SelectTrigger>
                            <SelectContent>
                              {insumosDisponibles.map(i => (
                                <SelectItem key={i.id} value={String(i.id)}>
                                  {i.emoji ? `${i.emoji} ` : ''}{i.nombre} ({i.unidad})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="col-span-3">
                          <Label className="text-xs text-muted-foreground">Cantidad ({insumo?.unidad ?? '—'})</Label>
                          <Input
                            type="number" min="0" step="0.01"
                            value={l.cantidad}
                            onChange={(e) => updateLinea(idx, { cantidad: Number(e.target.value) || 0 })}
                          />
                        </div>
                        <div className="col-span-2">
                          <Label className="text-xs text-muted-foreground">Merma %</Label>
                          <Input
                            type="number" min="0" max="100" step="0.5"
                            value={l.merma_pct}
                            onChange={(e) => updateLinea(idx, { merma_pct: Number(e.target.value) || 0 })}
                          />
                        </div>
                        <div className="col-span-1 text-right">
                          <Label className="text-xs text-muted-foreground">Subtotal</Label>
                          <div className="text-xs tabular-nums pt-2">
                            {subtotal != null ? formatARS(subtotal) : '—'}
                          </div>
                        </div>
                        <div className="col-span-1 text-right">
                          <Button
                            variant="ghost" size="sm"
                            onClick={() => eliminarLinea(idx)}
                            className="text-destructive h-9 w-9 p-0"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || loading || !nombre.trim()}>
            {saving ? 'Guardando…' : 'Guardar receta'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
