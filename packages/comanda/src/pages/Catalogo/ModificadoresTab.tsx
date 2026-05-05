import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, X, Settings2 } from 'lucide-react';
import type { Usuario } from '../../types/auth';
import type { ModifierGroup, Modifier, ModifierTipo } from '../../types/database';
import {
  listModifierGroups, createModifierGroup, updateModifierGroup, softDeleteModifierGroup,
  listModifiers, createModifier, updateModifier, softDeleteModifier,
} from '../../services/modifiersService';
import { tienePermiso } from '../../lib/auth';
import { Badge } from '../../components/Badge';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { MoneyInput } from '../../components/MoneyInput';
import { validarNombre, validarMinMax } from '../../lib/validate';
import { formatARS } from '../../lib/format';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

interface Props { user: Usuario }

export function ModificadoresTab({ user }: Props) {
  const [groups, setGroups] = useState<ModifierGroup[]>([]);
  const [editing, setEditing] = useState<ModifierGroup | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ModifierGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const puedeEditar = tienePermiso(user, 'comanda.modifiers.editar');

  const reload = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await listModifierGroups(user.tenant_id);
    if (err) setError(err);
    setGroups(data);
    setLoading(false);
  }, [user.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-muted-foreground">
          Grupos de modificadores reusables. Cada grupo se asigna a varios items.
        </p>
        {puedeEditar && (
          <Button size="lg" onClick={() => setEditing('new')}>
            <Plus className="h-5 w-5" />
            Nuevo grupo
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {loading ? (
        <Card><CardContent className="py-16 text-center text-muted-foreground">Cargando…</CardContent></Card>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
              <Settings2 className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-1">Sin grupos de modificadores</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-6">
              Los modificadores son opciones (cocción, extras, sin sal) que se asignan a items.
            </p>
            {puedeEditar && (
              <Button onClick={() => setEditing('new')}>
                <Plus className="h-5 w-5" />
                Crear primer grupo
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {groups.map((g) => (
            <ModifierGroupCard
              key={g.id}
              group={g}
              puedeEditar={puedeEditar}
              tenantId={user.tenant_id}
              onEdit={() => setEditing(g)}
              onDelete={() => setConfirmDelete(g)}
            />
          ))}
        </div>
      )}

      {editing && (
        <GroupForm
          user={user}
          group={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Eliminar grupo de modificadores"
        destructive
        description={confirmDelete ? <>¿Borrar <strong>{confirmDelete.nombre}</strong>? Las asignaciones a items se mantienen pero el grupo desaparece de los desplegables.</> : ''}
        confirmLabel="Eliminar"
        onConfirm={async () => {
          if (!confirmDelete) return;
          const { error: err } = await softDeleteModifierGroup(confirmDelete.id);
          if (err) setError(err);
          setConfirmDelete(null);
          reload();
        }}
      />
    </div>
  );
}

interface CardProps {
  group: ModifierGroup;
  puedeEditar: boolean;
  tenantId: string | null;
  onEdit: () => void;
  onDelete: () => void;
}

function ModifierGroupCard({ group, puedeEditar, tenantId, onEdit, onDelete }: CardProps) {
  const [opciones, setOpciones] = useState<Modifier[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevoPrecio, setNuevoPrecio] = useState(0);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const { data } = await listModifiers(group.id);
    setOpciones(data);
    setLoading(false);
  }, [group.id]);

  useEffect(() => { reload(); }, [reload]);

  async function addOpcion() {
    const eN = validarNombre(nuevoNombre); if (eN) { alert(eN); return; }
    if (!tenantId) return;
    const { error: err } = await createModifier({
      modifier_group_id: group.id, tenant_id: tenantId,
      nombre: nuevoNombre.trim(), precio_extra: nuevoPrecio,
      orden: opciones.length, activo: true,
    });
    if (err) { alert(err); return; }
    setNuevoNombre(''); setNuevoPrecio(0); setShowAdd(false);
    reload();
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <strong className="text-base">{group.nombre}</strong>
            <div className="flex gap-1 mt-1 flex-wrap">
              <Badge variant="violet">{tipoLabel(group.tipo)}</Badge>
              {group.requerido && <Badge variant="amber">Requerido</Badge>}
              <Badge variant="gray">
                min {group.min_seleccion} / max {group.max_seleccion ?? '∞'}
              </Badge>
            </div>
          </div>
          {puedeEditar && (
            <div className="flex gap-1 flex-shrink-0">
              <Button variant="ghost" size="sm" onClick={onEdit}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={onDelete}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>

        {group.descripcion && (
          <div className="mt-2 text-sm text-muted-foreground">{group.descripcion}</div>
        )}

        <div className="mt-3 pt-3 border-t border-border">
          <div className="text-xs font-medium text-foreground mb-2">Opciones</div>
          {loading && <div className="text-xs text-muted-foreground">…</div>}
          {!loading && opciones.length === 0 && (
            <div className="text-xs text-muted-foreground">Sin opciones</div>
          )}
          {opciones.map((op) => (
            <div key={op.id} className="flex items-center justify-between py-1 text-sm">
              <span>{op.nombre}</span>
              <div className="flex gap-2 items-center">
                {Number(op.precio_extra) > 0 && (
                  <span className="text-xs text-success tabular-nums">
                    +{formatARS(op.precio_extra)}
                  </span>
                )}
                {puedeEditar && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={async () => {
                      if (!confirm(`Borrar opción "${op.nombre}"?`)) return;
                      await softDeleteModifier(op.id);
                      reload();
                    }}
                    aria-label={`Borrar ${op.nombre}`}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
                {puedeEditar && (
                  <Switch
                    checked={op.activo}
                    onCheckedChange={async (v) => { await updateModifier(op.id, { activo: v }); reload(); }}
                    aria-label={`Activar ${op.nombre}`}
                  />
                )}
              </div>
            </div>
          ))}

          {puedeEditar && !showAdd && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 text-xs"
              onClick={() => setShowAdd(true)}
            >
              <Plus className="h-3 w-3" />
              Agregar opción
            </Button>
          )}
          {puedeEditar && showAdd && (
            <div className="mt-2 flex gap-1.5">
              <Input
                value={nuevoNombre}
                onChange={(e) => setNuevoNombre(e.target.value)}
                placeholder="Nombre"
                autoFocus
                className="h-9 text-xs flex-[2]"
              />
              <div className="flex-1">
                <MoneyInput value={nuevoPrecio} onChange={setNuevoPrecio} placeholder="$0,00" className="h-9 text-xs" />
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addOpcion}>
                OK
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => { setShowAdd(false); setNuevoNombre(''); setNuevoPrecio(0); }}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function tipoLabel(t: ModifierTipo): string {
  switch (t) {
    case 'opcion': return 'Opción única';
    case 'extra': return 'Extra (múltiple)';
    case 'aclaracion': return 'Aclaración';
    case 'sin_con': return 'Sin / Con';
  }
}

function GroupForm({ user, group, onClose, onSaved }: { user: Usuario; group: ModifierGroup | null; onClose: () => void; onSaved: () => void }) {
  const [nombre, setNombre] = useState(group?.nombre ?? '');
  const [descripcion, setDescripcion] = useState(group?.descripcion ?? '');
  const [tipo, setTipo] = useState<ModifierTipo>(group?.tipo ?? 'opcion');
  const [requerido, setRequerido] = useState(group?.requerido ?? false);
  const [minSel, setMinSel] = useState(group?.min_seleccion ?? 0);
  const [maxSel, setMaxSel] = useState<number | null>(group?.max_seleccion ?? 1);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const eN = validarNombre(nombre); if (eN) { setError(eN); return; }
    const eM = validarMinMax(minSel, maxSel); if (eM) { setError(eM); return; }
    if (!user.tenant_id) { setError('Sin tenant'); return; }
    setSaving(true);
    const draft = {
      nombre: nombre.trim(), descripcion: descripcion.trim() || null,
      tipo, requerido, min_seleccion: minSel, max_seleccion: maxSel,
      tenant_id: user.tenant_id, local_id: null,
    };
    const { error: err } = group ? await updateModifierGroup(group.id, draft) : await createModifierGroup(draft);
    setSaving(false);
    if (err) { setError(err); return; }
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{group ? 'Editar grupo' : 'Nuevo grupo de modificadores'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="m-nombre">Nombre *</Label>
            <Input id="m-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} required autoFocus className="h-11" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="m-desc">Descripción</Label>
            <Textarea id="m-desc" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} rows={2} />
          </div>

          <div className="space-y-2">
            <Label>Tipo</Label>
            <Select value={tipo} onValueChange={(v) => setTipo(v as ModifierTipo)}>
              <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="opcion">Opción única (cocción)</SelectItem>
                <SelectItem value="extra">Extra múltiple (guarniciones)</SelectItem>
                <SelectItem value="aclaracion">Aclaración (texto libre)</SelectItem>
                <SelectItem value="sin_con">Sin / Con (ingredientes)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <Label className="cursor-pointer">Requerido</Label>
            <Switch checked={requerido} onCheckedChange={setRequerido} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="m-min">Mín selección</Label>
              <Input
                id="m-min" type="number" min={0} value={minSel}
                onChange={(e) => setMinSel(Number(e.target.value))}
                className="h-11 tabular-nums"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="m-max">Máx selección (vacío = sin límite)</Label>
              <Input
                id="m-max" type="number" min={0} value={maxSel ?? ''}
                onChange={(e) => setMaxSel(e.target.value ? Number(e.target.value) : null)}
                className="h-11 tabular-nums"
              />
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
