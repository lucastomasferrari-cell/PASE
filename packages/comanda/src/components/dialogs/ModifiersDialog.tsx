import { useEffect, useState, useMemo } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import { X, Plus, Check } from 'lucide-react';
import { db } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Stepper } from '@/components/Stepper';
import type { ItemConGrupo } from '@/services/itemsService';
import type {
  ModifierGroup, Modifier, VentaPosItemModificador,
} from '@/types/database';
import { formatARS } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ItemConGrupo;
  onConfirm: (modificadores: VentaPosItemModificador[], notas: string | null, cantidad: number) => Promise<void> | void;
}

interface GroupConOpciones extends ModifierGroup {
  opciones: Modifier[];
}

// Sprint UX deep — Panel lateral desde la derecha (no full-screen modal) para
// mantener el catálogo visible mientras el cajero personaliza. Incluye stepper
// de cantidad para "3 hamburguesas con queso extra" en una sola operación, y
// total live (item × cantidad + extras) abajo siempre visible.
export function ModifiersDialog({ open, onOpenChange, item, onConfirm }: Props) {
  const [groups, setGroups] = useState<GroupConOpciones[]>([]);
  const [loading, setLoading] = useState(true);
  const [seleccion, setSeleccion] = useState<Record<number, Set<number>>>({});
  const [notas, setNotas] = useState('');
  const [cantidad, setCantidad] = useState(1);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSeleccion({}); setNotas(''); setCantidad(1); setSaving(false);
    setLoading(true);
    (async () => {
      const { data: asigs } = await db
        .from('item_modifier_groups')
        .select('modifier_group_id')
        .eq('item_id', item.id);
      const groupIds = (asigs ?? []).map((a) => (a as { modifier_group_id: number }).modifier_group_id);
      if (groupIds.length === 0) {
        setGroups([]);
        setLoading(false);
        return;
      }
      const [{ data: mgs }, { data: mods }] = await Promise.all([
        db.from('modifier_groups').select('*').in('id', groupIds).is('deleted_at', null),
        db.from('modifiers').select('*').in('modifier_group_id', groupIds).is('deleted_at', null).eq('activo', true),
      ]);
      const opcionesByGroup = new Map<number, Modifier[]>();
      for (const m of mods ?? []) {
        const id = (m as Modifier).modifier_group_id;
        if (!opcionesByGroup.has(id)) opcionesByGroup.set(id, []);
        opcionesByGroup.get(id)!.push(m as Modifier);
      }
      const enriched: GroupConOpciones[] = (mgs ?? []).map((g) => ({
        ...(g as ModifierGroup),
        opciones: opcionesByGroup.get((g as ModifierGroup).id) ?? [],
      }));
      setGroups(enriched);
      setLoading(false);
    })();
  }, [open, item.id]);

  // Chequea si una selección dada cumple TODOS los requisitos (obligatorios + min/max).
  function requisitosOk(sel: Record<number, Set<number>>): boolean {
    for (const g of groups) {
      const count = sel[g.id]?.size ?? 0;
      if (g.requerido && count === 0) return false;
      if (g.min_seleccion > 0 && count < g.min_seleccion) return false;
      if (g.max_seleccion !== null && count > g.max_seleccion) return false;
    }
    return true;
  }

  function construirMods(sel: Record<number, Set<number>>): VentaPosItemModificador[] {
    const result: VentaPosItemModificador[] = [];
    for (const g of groups) {
      const s = sel[g.id];
      if (!s) continue;
      for (const op of g.opciones) {
        if (s.has(op.id)) {
          result.push({ nombre: op.nombre, precio_extra: Number(op.precio_extra), modifier_id: op.id });
        }
      }
    }
    return result;
  }

  function toggle(groupId: number, modifierId: number, group: GroupConOpciones) {
    const cur = new Set(seleccion[groupId] ?? []);
    let added = false;
    if (cur.has(modifierId)) {
      cur.delete(modifierId);
    } else {
      if (group.tipo === 'opcion') {
        cur.clear();
      } else if (group.max_seleccion !== null && cur.size >= group.max_seleccion) {
        toast.warning(`${group.nombre}: máximo ${group.max_seleccion} opciones`);
        return;
      }
      cur.add(modifierId);
      added = true;
    }
    const newSel = { ...seleccion, [groupId]: cur };
    setSeleccion(newSel);
    // Auto-agregar: si al tocar una opción de elección única se completan TODOS
    // los obligatorios, agregamos el producto directo (sin tocar "Agregar").
    // El cajero igual puede ajustar cantidad antes (footer) o dejar nota.
    if (added && group.tipo === 'opcion' && requisitosOk(newSel)) {
      void confirmarCon(newSel);
    }
  }

  function validar(): { ok: boolean; error?: string } {
    for (const g of groups) {
      const sel = seleccion[g.id];
      const count = sel?.size ?? 0;
      if (g.requerido && count === 0) return { ok: false, error: `${g.nombre} es requerido` };
      if (g.min_seleccion > 0 && count < g.min_seleccion) {
        return { ok: false, error: `${g.nombre}: mínimo ${g.min_seleccion}` };
      }
      if (g.max_seleccion !== null && count > g.max_seleccion) {
        return { ok: false, error: `${g.nombre}: máximo ${g.max_seleccion}` };
      }
    }
    return { ok: true };
  }

  const totalExtras = useMemo(() => {
    let s = 0;
    for (const g of groups) {
      const sel = seleccion[g.id];
      if (!sel) continue;
      for (const op of g.opciones) {
        if (sel.has(op.id)) s += Number(op.precio_extra);
      }
    }
    return s;
  }, [groups, seleccion]);

  const totalLive = (Number(item.precio_madre) + totalExtras) * cantidad;
  const requisitosFaltantes = useMemo(() => {
    return groups.filter((g) => {
      const count = seleccion[g.id]?.size ?? 0;
      if (g.requerido && count === 0) return true;
      if (g.min_seleccion > 0 && count < g.min_seleccion) return true;
      return false;
    }).length;
  }, [groups, seleccion]);

  async function confirmarCon(sel: Record<number, Set<number>>) {
    if (saving) return;
    setSaving(true);
    try {
      await onConfirm(construirMods(sel), notas.trim() || null, cantidad);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error agregando item');
    } finally {
      setSaving(false);
    }
  }

  async function confirmar() {
    const v = validar();
    if (!v.ok) { toast.error(v.error ?? 'Validación falló'); return; }
    await confirmarCon(seleccion);
  }

  useEffect(() => {
    if (open && !loading && groups.length === 0) {
      void onConfirm([], null, 1);
      onOpenChange(false);
    }
  }, [open, loading, groups.length, onConfirm, onOpenChange]);

  if (groups.length === 0 && !loading) return null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed right-0 top-0 z-50 h-full w-full sm:w-[440px] bg-background border-l shadow-xl',
            'flex flex-col',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
            'duration-200',
          )}
        >
          {/* HEADER */}
          <div className="px-4 py-3 border-b flex items-start gap-3">
            <div className="text-2xl shrink-0">{item.emoji ?? '🍽️'}</div>
            <div className="flex-1 min-w-0">
              <DialogPrimitive.Title className="text-base font-semibold leading-tight">
                {item.nombre}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-xs text-muted-foreground mt-0.5">
                {formatARS(item.precio_madre)} base · Personalizá antes de agregar
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              className="text-muted-foreground hover:text-foreground p-1 -m-1 rounded"
              aria-label="Cerrar"
            >
              <X className="h-5 w-5" />
            </DialogPrimitive.Close>
          </div>

          {/* BODY scrolleable */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            {loading ? (
              <div className="py-8 text-center text-muted-foreground text-sm">Cargando opciones…</div>
            ) : (
              <>
                {groups.map((g) => {
                  const count = seleccion[g.id]?.size ?? 0;
                  return (
                    <div key={g.id} className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label className="text-sm font-medium flex items-center gap-1.5">
                          {g.nombre}
                          {g.requerido && (
                            count > 0 ? (
                              <Check className="h-3.5 w-3.5 text-primary" />
                            ) : (
                              <span className="text-[10px] px-1.5 py-0.5 rounded uppercase font-medium tracking-wide bg-muted text-muted-foreground">
                                Elegí 1
                              </span>
                            )
                          )}
                        </Label>
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {g.tipo === 'opcion' ? `${count}/1` :
                           g.tipo === 'sin_con' ? 'Sin/Con' :
                           g.max_seleccion !== null ? `${count}/${g.max_seleccion}` :
                           `${count} elegidas`}
                        </span>
                      </div>
                      <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
                        {g.opciones.map((op) => {
                          const selected = seleccion[g.id]?.has(op.id) ?? false;
                          const extra = Number(op.precio_extra);
                          return (
                            <button
                              key={op.id}
                              type="button"
                              onClick={() => toggle(g.id, op.id, g)}
                              className={cn(
                                'w-full flex items-center justify-between gap-3 px-3 py-3 text-left transition-colors',
                                selected ? 'bg-primary/5' : 'hover:bg-accent/40 active:bg-accent/60',
                              )}
                            >
                              <span className="flex items-center gap-3 min-w-0">
                                <span className={cn(
                                  'h-5 w-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors',
                                  selected ? 'border-primary' : 'border-border',
                                )}>
                                  {selected && <span className="h-2.5 w-2.5 rounded-full bg-primary" />}
                                </span>
                                <span className={cn('text-sm truncate text-foreground', selected ? 'font-semibold' : 'font-medium')}>
                                  {op.nombre}
                                </span>
                              </span>
                              <span className={cn(
                                'text-xs tabular-nums shrink-0',
                                extra > 0 ? 'text-success font-medium'
                                  : extra < 0 ? 'text-muted-foreground'
                                  : selected ? 'text-primary font-medium' : 'text-muted-foreground',
                              )}>
                                {extra > 0 ? `+${formatARS(extra)}`
                                  : extra < 0 ? `−${formatARS(Math.abs(extra))}`
                                  : 'Incluido'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                <div className="space-y-1.5 pt-2">
                  <Label htmlFor="notas-mod" className="text-sm">Aclaraciones (opcional)</Label>
                  <Textarea
                    id="notas-mod"
                    value={notas}
                    onChange={(e) => setNotas(e.target.value)}
                    rows={2}
                    placeholder="Sin sal / cocción jugosa / etc."
                    className="text-sm"
                  />
                </div>
              </>
            )}
          </div>

          {/* FOOTER fijo con cantidad + total + CTA */}
          <div className="border-t bg-card px-4 py-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Cantidad</span>
                <Stepper value={cantidad} onChange={setCantidad} min={1} max={99} size="lg" />
              </div>
              <div className="text-right">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Total</div>
                <div className="text-xl font-bold tabular-nums leading-none">{formatARS(totalLive)}</div>
                {totalExtras > 0 && (
                  <div className="text-[10px] text-success tabular-nums mt-0.5">
                    +{formatARS(totalExtras)} extras × {cantidad}
                  </div>
                )}
              </div>
            </div>

            {requisitosFaltantes > 0 && (
              <div className="text-[11px] text-muted-foreground bg-muted rounded px-2 py-1">
                Elegí una opción para continuar
              </div>
            )}

            <div className="grid grid-cols-[auto_1fr] gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancelar
              </Button>
              <Button
                onClick={confirmar}
                disabled={saving || loading || requisitosFaltantes > 0}
                size="lg"
                className="font-semibold"
              >
                <Plus className="h-4 w-4 mr-1.5" />
                {saving ? 'Agregando…' : `Agregar${cantidad > 1 ? ` ${cantidad}` : ''}`}
              </Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
