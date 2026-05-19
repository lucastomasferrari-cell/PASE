import { useEffect, useRef, useState, useCallback } from 'react';
import { Plus, Pencil, Link2, Pencil as PencilIcon, ShoppingBag } from 'lucide-react';
import type { Usuario } from '../../types/auth';
import type { Canal, ModoPos } from '../../types/database';
import { listCanales, createCanal, updateCanal, toggleCanalActivo } from '../../services/canalesService';
import type { CanalDraft } from '../../services/canalesService';
import { tienePermiso } from '../../lib/auth';
import { Badge } from '../../components/Badge';
import { EmojiPicker } from '../../components/EmojiPicker';
import { validarNombre, validarSlug, validarPorcentaje } from '../../lib/validate';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { DEFAULT_PICKER_COLOR } from '@/lib/utils';
// useRealtimeTable sacado sprint optim egress 2026-05-16

interface Props { user: Usuario }

export function CanalesTab({ user }: Props) {
  const [canales, setCanales] = useState<Canal[]>([]);
  const [editing, setEditing] = useState<Canal | 'new' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const puedeEditar = tienePermiso(user, 'comanda.canales.editar');

  const reload = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await listCanales(user.tenant_id);
    if (err) setError(err);
    setCanales(data);
    setLoading(false);
  }, [user.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  // Realtime SACADO sprint optimización egress 2026-05-16. Canales son
  // config rara vez modificada (1-3 cambios al mes). No vale subscription.

  return (
    <div className="container py-6">
      <header className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Canales de venta</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {canales.length} {canales.length === 1 ? 'canal' : 'canales'} · cada canal define dónde se vende y con qué ajuste de precio (Salón, Rappi, Tienda, etc.)
          </p>
        </div>
        {puedeEditar && (
          <Button onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4 mr-1.5" />
            Nuevo canal
          </Button>
        )}
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {loading ? (
        <Card><CardContent className="py-16 text-center text-muted-foreground">Cargando…</CardContent></Card>
      ) : canales.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
              <ShoppingBag className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-1">Sin canales configurados</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-6">
              Cada canal define dónde se vende y con qué ajuste de precio (Salón, Rappi, Tienda, etc.).
            </p>
            {puedeEditar && (
              <Button onClick={() => setEditing('new')}>
                <Plus className="h-5 w-5" />
                Crear primer canal
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[2fr_120px_180px_100px_100px_120px_100px_140px] gap-4 px-6 py-3 border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <div>Canal</div>
            <div>Modo POS</div>
            <div>Atadura</div>
            <div className="text-right">Ajuste vs Madre</div>
            <div className="text-right">Comisión</div>
            <div className="text-right">Redondeo</div>
            <div>Activo</div>
            <div className="text-right">Acciones</div>
          </div>
          {canales.map((c, idx) => (
            <div
              key={c.id}
              className={`grid grid-cols-[2fr_120px_180px_100px_100px_120px_100px_140px] gap-4 px-6 py-4 items-center transition-colors hover:bg-muted/30 ${
                idx !== canales.length - 1 ? 'border-b border-border' : ''
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-lg flex-shrink-0">{c.emoji ?? '🛍️'}</span>
                <div className="min-w-0">
                  <div className="font-medium truncate">{c.nombre}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {c.slug}{c.grupo ? ` · ${c.grupo}` : ''}
                  </div>
                </div>
              </div>
              <div><Badge variant="blue">{c.modo_pos}</Badge></div>
              <div>
                {c.atado_madre ? (
                  <Badge variant="violet">
                    <Link2 className="h-3 w-3 mr-1 inline" />
                    Atado al madre
                  </Badge>
                ) : (
                  <Badge variant="gray">
                    <PencilIcon className="h-3 w-3 mr-1 inline" />
                    Independiente
                  </Badge>
                )}
              </div>
              <div className="text-right tabular-nums text-sm">
                {Number(c.ajuste_madre_pct) > 0 ? '+' : ''}{Number(c.ajuste_madre_pct).toFixed(2)}%
              </div>
              <div className="text-right tabular-nums text-sm">
                {Number(c.comision_externa_pct).toFixed(2)}%
              </div>
              <div className="text-right text-sm text-muted-foreground">
                {c.redondeo_a === 1 ? 'al peso' : `a $${c.redondeo_a}`}
              </div>
              <div>
                <Switch
                  checked={c.activo}
                  disabled={!puedeEditar}
                  onCheckedChange={async (checked) => {
                    const { error: err } = await toggleCanalActivo(c.id, checked);
                    if (err) setError(err);
                    reload();
                  }}
                />
              </div>
              <div className="flex justify-end">
                {puedeEditar && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>
                    <Pencil className="h-4 w-4" />
                    Editar
                  </Button>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}

      {editing && (
        <CanalForm
          user={user}
          canal={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

function CanalForm({ user, canal, onClose, onSaved }: { user: Usuario; canal: Canal | null; onClose: () => void; onSaved: () => void }) {
  const [nombre, setNombre] = useState(canal?.nombre ?? '');
  const [slug, setSlug] = useState(canal?.slug ?? '');
  const [emoji, setEmoji] = useState<string | null>(canal?.emoji ?? null);
  const [color, setColor] = useState(canal?.color ?? DEFAULT_PICKER_COLOR);
  const [modoPos, setModoPos] = useState<ModoPos>(canal?.modo_pos ?? 'salon');
  const [atadoMadre, setAtadoMadre] = useState(canal?.atado_madre ?? true);
  const [ajustePct, setAjustePct] = useState<number>(canal?.ajuste_madre_pct ?? 0);
  const [comisionPct, setComisionPct] = useState<number>(canal?.comision_externa_pct ?? 0);
  const [redondeoA, setRedondeoA] = useState<number>(canal?.redondeo_a ?? 1);
  const [activo, setActivo] = useState(canal?.activo ?? true);
  const [grupo, setGrupo] = useState(canal?.grupo ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    const eN = validarNombre(nombre); if (eN) { setError(eN); return; }
    const eS = validarSlug(slug); if (eS) { setError(eS); return; }
    const eA = validarPorcentaje(ajustePct); if (eA) { setError(eA); return; }
    const eC = validarPorcentaje(comisionPct); if (eC) { setError(eC); return; }
    if (!user.tenant_id) { setError('Sin tenant'); return; }

    savingRef.current = true;
    setSaving(true);
    try {
      const draft: CanalDraft = {
        nombre: nombre.trim(), slug: slug.trim(), emoji, color,
        modo_pos: modoPos, atado_madre: atadoMadre,
        ajuste_madre_pct: ajustePct, comision_externa_pct: comisionPct,
        redondeo_a: redondeoA, activo, grupo: grupo.trim() || null,
        tenant_id: user.tenant_id, local_id: null,
      };
      const { error: err } = canal ? await updateCanal(canal.id, draft) : await createCanal(draft);
      if (err) { setError(err); return; }
      onSaved();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{canal ? 'Editar canal' : 'Nuevo canal'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Emoji</Label>
            <EmojiPicker value={emoji} onChange={setEmoji} />
          </div>

          <div className="grid grid-cols-[2fr_1fr] gap-3">
            <div className="space-y-2">
              <Label htmlFor="c-nombre">Nombre *</Label>
              <Input id="c-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} required autoFocus className="h-11" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-color">Color</Label>
              <Input id="c-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-11 p-1" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="c-slug">Slug *</Label>
              <Input id="c-slug" value={slug} onChange={(e) => setSlug(e.target.value)} required placeholder="rappi" className="h-11" />
            </div>
            <div className="space-y-2">
              <Label>Modo POS *</Label>
              <Select value={modoPos} onValueChange={(v) => setModoPos(v as ModoPos)}>
                <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="salon">Salón</SelectItem>
                  <SelectItem value="mostrador">Mostrador</SelectItem>
                  <SelectItem value="pedidos">Pedidos</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-primary" />
              <Label className="cursor-pointer">Atado al precio madre (recálculo automático)</Label>
            </div>
            <Switch checked={atadoMadre} onCheckedChange={setAtadoMadre} />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor="c-ajuste">Ajuste %</Label>
              <Input
                id="c-ajuste"
                type="number" step="0.01" value={ajustePct}
                onChange={(e) => setAjustePct(Number(e.target.value))}
                className="h-11 tabular-nums"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-comision">Comisión %</Label>
              <Input
                id="c-comision"
                type="number" step="0.01" value={comisionPct}
                onChange={(e) => setComisionPct(Number(e.target.value))}
                className="h-11 tabular-nums"
              />
            </div>
            <div className="space-y-2">
              <Label>Redondeo a</Label>
              <Select value={String(redondeoA)} onValueChange={(v) => setRedondeoA(Number(v))}>
                <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Al peso</SelectItem>
                  <SelectItem value="10">Decena</SelectItem>
                  <SelectItem value="100">Centena</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="c-grupo">Grupo (opcional)</Label>
              <Input
                id="c-grupo"
                value={grupo}
                onChange={(e) => setGrupo(e.target.value)}
                placeholder="presencial / third-party / online-propio"
                className="h-11"
              />
            </div>
            <div className="flex items-end">
              <div className="flex items-center justify-between rounded-md border border-border p-3 w-full h-11">
                <Label className="cursor-pointer">Activo</Label>
                <Switch checked={activo} onCheckedChange={setActivo} />
              </div>
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
