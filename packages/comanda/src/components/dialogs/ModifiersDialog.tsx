import { useEffect, useState, useMemo } from 'react';
import { toast } from 'sonner';
import { db } from '@/lib/supabase';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
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
  onConfirm: (modificadores: VentaPosItemModificador[], notas: string | null) => Promise<void> | void;
}

interface GroupConOpciones extends ModifierGroup {
  opciones: Modifier[];
}

// Carga modifier_groups asignados al item + sus opciones, presenta selección
// según tipo y reglas (required, min/max), valida y devuelve array final.
export function ModifiersDialog({ open, onOpenChange, item, onConfirm }: Props) {
  const [groups, setGroups] = useState<GroupConOpciones[]>([]);
  const [loading, setLoading] = useState(true);
  const [seleccion, setSeleccion] = useState<Record<number, Set<number>>>({});  // groupId → set de modifierId
  const [notas, setNotas] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSeleccion({}); setNotas(''); setSaving(false);
    setLoading(true);
    (async () => {
      // Asignaciones item ↔ modifier_groups
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

  function toggle(groupId: number, modifierId: number, group: GroupConOpciones) {
    setSeleccion((prev) => {
      const cur = new Set(prev[groupId] ?? []);
      if (cur.has(modifierId)) {
        cur.delete(modifierId);
      } else {
        // Si tipo opcion (única), reemplazar
        if (group.tipo === 'opcion') {
          cur.clear();
        } else if (group.max_seleccion !== null && cur.size >= group.max_seleccion) {
          toast.warning(`${group.nombre}: máximo ${group.max_seleccion} opciones`);
          return prev;
        }
        cur.add(modifierId);
      }
      return { ...prev, [groupId]: cur };
    });
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

  async function confirmar() {
    const v = validar();
    if (!v.ok) { toast.error(v.error ?? 'Validación falló'); return; }
    const result: VentaPosItemModificador[] = [];
    for (const g of groups) {
      const sel = seleccion[g.id];
      if (!sel) continue;
      for (const op of g.opciones) {
        if (sel.has(op.id)) {
          result.push({
            nombre: op.nombre,
            precio_extra: Number(op.precio_extra),
            modifier_id: op.id,
          });
        }
      }
    }
    setSaving(true);
    try {
      await onConfirm(result, notas.trim() || null);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error agregando item');
    } finally {
      setSaving(false);
    }
  }

  // Si no tiene modifiers asignados, llamamos onConfirm directo y cerramos
  useEffect(() => {
    if (open && !loading && groups.length === 0) {
      void onConfirm([], null);
      onOpenChange(false);
    }
  }, [open, loading, groups.length, onConfirm, onOpenChange]);

  if (groups.length === 0 && !loading) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item.nombre}</DialogTitle>
          <DialogDescription>
            Personalizá el ítem antes de agregarlo
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-muted-foreground">Cargando opciones…</div>
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.id} className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">
                    {g.nombre}
                    {g.requerido && <span className="text-destructive ml-1">*</span>}
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {g.tipo === 'opcion' ? 'Elegí 1' :
                     g.tipo === 'extra' ? `Hasta ${g.max_seleccion ?? '∞'}` :
                     g.tipo === 'sin_con' ? 'Sin/Con' : 'Aclaración'}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {g.opciones.map((op) => {
                    const selected = seleccion[g.id]?.has(op.id) ?? false;
                    return (
                      <button
                        key={op.id}
                        type="button"
                        onClick={() => toggle(g.id, op.id, g)}
                        className={cn(
                          'p-2 rounded-md border text-sm text-left transition-colors',
                          selected
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-input hover:bg-accent',
                        )}
                      >
                        <div className="flex justify-between items-center gap-2">
                          <span className="truncate">{op.nombre}</span>
                          {Number(op.precio_extra) > 0 && (
                            <span className="text-xs text-success tabular-nums shrink-0">
                              +{formatARS(op.precio_extra)}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            <div className="space-y-2">
              <Label htmlFor="notas-mod">Aclaraciones (opcional)</Label>
              <Textarea
                id="notas-mod"
                value={notas}
                onChange={(e) => setNotas(e.target.value)}
                rows={2}
                placeholder="Sin sal / vegetariano / etc."
              />
            </div>

            {totalExtras > 0 && (
              <div className="rounded-md bg-muted p-2 text-sm flex justify-between">
                <span>Extras</span>
                <strong className="tabular-nums">+{formatARS(totalExtras)}</strong>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={confirmar} disabled={saving || loading}>
            {saving ? 'Agregando…' : 'Agregar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
