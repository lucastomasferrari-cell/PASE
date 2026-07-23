import { useEffect, useRef, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, FolderClosed } from 'lucide-react';
import type { Usuario } from '../../types/auth';
import type { ItemGrupo, TaxRate, Estacion } from '../../types/database';
import { listGrupos, createGrupo, updateGrupo, softDeleteGrupo, countItemsPorGrupo } from '../../services/gruposService';
import { listMarcas, type MarcaLite } from '../../services/marcasService';
import { listTaxRates } from '../../services/taxRatesService';
import { tienePermiso } from '../../lib/auth';
// useRealtimeTable sacado sprint optim egress 2026-05-16
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmojiPicker } from '../../components/EmojiPicker';
import { validarNombre } from '../../lib/validate';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DEFAULT_PICKER_COLOR } from '@/lib/utils';
import { ColorRampPicker, type ColorRamp, COLOR_RAMPS } from '@/components/ColorRampPicker';
import type { CatalogoScope } from '@/lib/catalogoScope';
import { useCatalogoScope, scopeToItemsFilter, scopeLocalId } from '@/lib/catalogoScope';
import { CatalogoScopeSelector } from '@/components/CatalogoScopeSelector';

interface Props {
  user: Usuario;
  /** Ver ItemsTab#Props.forceScope. */
  forceScope?: CatalogoScope;
}

export function GruposTab({ user, forceScope }: Props) {
  const [grupos, setGrupos] = useState<ItemGrupo[]>([]);
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [marcas, setMarcas] = useState<MarcaLite[]>([]);
  const [marcaFilter, setMarcaFilter] = useState<string>('todas');
  const [editing, setEditing] = useState<ItemGrupo | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ItemGrupo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hookScope] = useCatalogoScope();
  const scope = forceScope ?? hookScope;

  // Editar el MAESTRO requiere maestro.editar (solo dueño); en sucursal, el genérico.
  const puedeEditar = tienePermiso(user, scope === 'maestro' ? 'comanda.catalogo.maestro.editar' : 'comanda.catalogo.editar');
  // Ver el maestro en el selector: quien tenga importar (o editar, que lo incluye).
  const puedeVerMaestro = tienePermiso(user, 'comanda.catalogo.maestro.importar') || tienePermiso(user, 'comanda.catalogo.maestro.editar');
  const marcaIdFiltro = marcaFilter === 'todas' ? null : Number(marcaFilter);

  const reload = useCallback(async () => {
    setLoading(true);
    const marcaIdNum = marcaFilter === 'todas' ? null : Number(marcaFilter);
    const [gr, tr, ct] = await Promise.all([
      // Alcance: grupos del maestro (local_id NULL) o de la sucursal elegida.
      listGrupos(user.tenant_id, marcaIdNum, scopeToItemsFilter(scope)),
      listTaxRates(user.tenant_id),
      countItemsPorGrupo(user.tenant_id),
    ]);
    setGrupos(gr.data);
    setTaxRates(tr.data);
    setCounts(ct);
    setLoading(false);
  }, [user.tenant_id, marcaFilter, scope]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    listMarcas(user.tenant_id).then((r) => setMarcas(r.data));
  }, [user.tenant_id]);

  // Realtime SACADO sprint optimización egress 2026-05-16. Grupos rara vez
  // cambian, no vale el costo de subscription abierta. F5 si hace falta.

  return (
    <div className="container py-6">
      <header className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {scope === 'maestro' ? 'Grupos del menú maestro' : 'Grupos de la sucursal'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {grupos.length} {grupos.length === 1 ? 'grupo' : 'grupos'} · agrupan los items del catálogo por categoría (Rolls, Bebidas, etc.)
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!forceScope && <CatalogoScopeSelector hideMaestro={!puedeVerMaestro} />}
          {marcas.length > 0 && (
            <Select value={marcaFilter} onValueChange={setMarcaFilter}>
              <SelectTrigger className="w-[180px] h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todas">Todas las marcas</SelectItem>
                {marcas.map((m) => (
                  <SelectItem key={m.id} value={String(m.id)}>{m.nombre}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {puedeEditar && (
            <Button onClick={() => setEditing('new')}>
              <Plus className="h-4 w-4 mr-1.5" />
              Nuevo grupo
            </Button>
          )}
        </div>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {loading ? (
        <Card><CardContent className="py-16 text-center text-muted-foreground">Cargando…</CardContent></Card>
      ) : grupos.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
              <FolderClosed className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-1">Sin grupos en el catálogo</h3>
            <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
              Los grupos te ayudan a organizar el catálogo (Entradas, Principales, Bebidas…).
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
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[2fr_80px_1fr_140px_80px_180px] gap-4 px-6 py-3 border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <div>Grupo</div>
            <div>Color</div>
            <div>Tax</div>
            <div>Estación default</div>
            <div className="text-right">Items</div>
            <div className="text-right">Acciones</div>
          </div>
          {grupos.map((g, idx) => (
            <div
              key={g.id}
              className={`grid grid-cols-[2fr_80px_1fr_140px_80px_180px] gap-4 px-6 py-4 items-center transition-colors hover:bg-muted/30 ${
                idx !== grupos.length - 1 ? 'border-b border-border' : ''
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-lg">{g.emoji ?? '🗂️'}</span>
                <span className="font-medium truncate">{g.nombre}</span>
              </div>
              <div>
                {g.color ? (
                  <span
                    className="inline-block w-5 h-5 rounded border border-border"
                    style={{ background: g.color }}
                    title={g.color}
                  />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
              <div className="text-sm text-muted-foreground truncate">
                {taxRates.find((t) => t.id === g.tax_rate_id)?.nombre ?? '—'}
              </div>
              <div className="text-sm text-muted-foreground">
                {g.estacion_default ?? '—'}
              </div>
              <div className="text-right tabular-nums font-medium">{counts[g.id] ?? 0}</div>
              <div className="flex justify-end gap-1">
                {puedeEditar && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(g)}>
                    <Pencil className="h-4 w-4" />
                    Editar
                  </Button>
                )}
                {puedeEditar && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => setConfirmDelete(g)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}

      {editing && (
        <GrupoFormDialog
          user={user}
          taxRates={taxRates}
          marcas={marcas}
          defaultMarcaId={marcaIdFiltro}
          scopeLocalId={scopeLocalId(scope)}
          grupo={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Eliminar grupo"
        destructive
        description={confirmDelete ? <>¿Borrar grupo <strong>{confirmDelete.nombre}</strong>?</> : ''}
        confirmLabel="Eliminar"
        onConfirm={async () => {
          if (!confirmDelete) return;
          const { error: err } = await softDeleteGrupo(confirmDelete.id);
          if (err) setError(err);
          setConfirmDelete(null);
          reload();
        }}
      />
    </div>
  );
}

interface GrupoFormProps {
  user: Usuario;
  taxRates: TaxRate[];
  marcas: MarcaLite[];
  defaultMarcaId: number | null;
  /** Sucursal del alcance (null = maestro). Se graba al crear un grupo. */
  scopeLocalId: number | null;
  grupo: ItemGrupo | null;
  onClose: () => void;
  onSaved: () => void;
}

function GrupoFormDialog({ user, taxRates, marcas, defaultMarcaId, scopeLocalId, grupo, onClose, onSaved }: GrupoFormProps) {
  const [marcaId, setMarcaId] = useState<number | null>(
    grupo ? ((grupo as { marca_id?: number | null }).marca_id ?? null) : (defaultMarcaId ?? marcas[0]?.id ?? null),
  );
  const [nombre, setNombre] = useState(grupo?.nombre ?? '');
  const [emoji, setEmoji] = useState<string | null>(grupo?.emoji ?? null);
  const [color, setColor] = useState(grupo?.color ?? DEFAULT_PICKER_COLOR);
  // Validamos que el color_ramp existente esté en el set canónico.
  // Migration 202605061200 ya lo hace via CHECK, pero defensivo en cliente.
  const initialRamp = grupo?.color_ramp && (COLOR_RAMPS as readonly string[]).includes(grupo.color_ramp)
    ? (grupo.color_ramp as ColorRamp)
    : null;
  const [colorRamp, setColorRamp] = useState<ColorRamp | null>(initialRamp);
  const [orden, setOrden] = useState(grupo?.orden ?? 0);
  const [taxRateId, setTaxRateId] = useState<number | null>(grupo?.tax_rate_id ?? null);
  const [estacion, setEstacion] = useState<Estacion | ''>((grupo?.estacion_default as Estacion) ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    const eN = validarNombre(nombre);
    if (eN) { setError(eN); return; }
    if (!user.tenant_id) { setError('Sin tenant'); return; }
    savingRef.current = true;
    setSaving(true);
    try {
      const draft = {
        nombre: nombre.trim(), emoji, color, orden,
        tax_rate_id: taxRateId, estacion_default: estacion || null,
        tenant_id: user.tenant_id,
        local_id: grupo ? grupo.local_id : scopeLocalId,
        marca_id: marcaId,
        color_ramp: colorRamp,
      };
      const { error: err } = grupo ? await updateGrupo(grupo.id, draft) : await createGrupo(draft);
      if (err) { setError(err); return; }
      onSaved();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{grupo ? 'Editar grupo' : 'Nuevo grupo'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Emoji</Label>
            <EmojiPicker value={emoji} onChange={setEmoji} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="nombre">Nombre *</Label>
            <Input
              id="nombre" value={nombre} onChange={(e) => setNombre(e.target.value)}
              required autoFocus className="h-11"
            />
          </div>

          {marcas.length > 0 && (
            <div className="space-y-2">
              <Label>Marca</Label>
              <Select
                value={marcaId === null ? '_shared' : String(marcaId)}
                onValueChange={(v) => setMarcaId(v === '_shared' ? null : Number(v))}
              >
                <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
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
              <Label htmlFor="color">Color UI</Label>
              <Input
                id="color" type="color" value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-11 p-1"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="orden">Orden</Label>
              <Input
                id="orden" type="number" value={orden}
                onChange={(e) => setOrden(Number(e.target.value))}
                className="h-11"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Color para los tiles del POS</Label>
            <ColorRampPicker value={colorRamp} onChange={setColorRamp} />
            <p className="text-xs text-muted-foreground">
              Define el tono de los tiles del POS y el fallback de las cards
              de la tienda online cuando el item no tiene foto.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Tax rate default</Label>
            <Select
              value={taxRateId === null ? '_none' : String(taxRateId)}
              onValueChange={(v) => setTaxRateId(v === '_none' ? null : Number(v))}
            >
              <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">— sin default —</SelectItem>
                {taxRates.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    {t.nombre} ({t.porcentaje}%)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Estación cocina default</Label>
            <Select
              value={estacion === '' ? '_none' : estacion}
              onValueChange={(v) => setEstacion(v === '_none' ? '' : (v as Estacion))}
            >
              <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">— sin default —</SelectItem>
                <SelectItem value="cocina_caliente">Cocina caliente</SelectItem>
                <SelectItem value="cocina_fria">Cocina fría</SelectItem>
                <SelectItem value="barra">Barra</SelectItem>
                <SelectItem value="postres">Postres</SelectItem>
              </SelectContent>
            </Select>
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
