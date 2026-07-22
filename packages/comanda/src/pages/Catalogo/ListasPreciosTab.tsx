import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Tag, Link2, Check, Info } from 'lucide-react';
import type { Usuario } from '../../types/auth';
import {
  listListasPrecios, createListaPrecio, updateListaPrecio, setCanalLista,
  type ListaPrecioConUso, type ListaPrecioDraft,
} from '../../services/listasPreciosService';
import { listCanales } from '../../services/canalesService';
import type { Canal } from '../../types/database';
import { tienePermiso } from '../../lib/auth';
import { Badge } from '../../components/Badge';
import { validarNombre, validarPorcentaje } from '../../lib/validate';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

interface Props { user: Usuario }

export function ListasPreciosTab({ user }: Props) {
  const [listas, setListas] = useState<ListaPrecioConUso[]>([]);
  const [canales, setCanales] = useState<Canal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ListaPrecioConUso | 'new' | null>(null);
  const [asignando, setAsignando] = useState<ListaPrecioConUso | null>(null);

  const puedeEditar = tienePermiso(user, 'comanda.precios.editar');
  const puedeAsignar = tienePermiso(user, 'comanda.canales.editar');

  const reload = useCallback(async () => {
    setLoading(true);
    const [lRes, cRes] = await Promise.all([
      listListasPrecios(user.tenant_id),
      listCanales(user.tenant_id),
    ]);
    if (lRes.error) setError(lRes.error);
    else if (cRes.error) setError(cRes.error);
    else setError(null);
    setListas(lRes.data);
    setCanales(cRes.data);
    setLoading(false);
  }, [user.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  const canalesSinLista = canales.filter((c) => c.lista_precio_id == null);

  return (
    <div className="container py-6">
      <header className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Listas de precios</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {listas.length} {listas.length === 1 ? 'lista' : 'listas'} · una lista es un juego de precios con nombre propio. Varios canales pueden compartir la misma lista.
          </p>
        </div>
        {puedeEditar && (
          <Button onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4 mr-1.5" />
            Nueva lista
          </Button>
        )}
      </header>

      <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 p-3.5 text-sm">
        <Info className="h-4 w-4 mt-0.5 flex-shrink-0 text-primary" />
        <p className="text-muted-foreground">
          Acá definís las listas y qué canal usa cada una. La asignación se guarda ya mismo.
          La conexión con el precio que sale al cobrar se activa en el próximo paso (lo prendemos y testeamos juntos).
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {loading ? (
        <Card><CardContent className="py-16 text-center text-muted-foreground">Cargando…</CardContent></Card>
      ) : listas.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
              <Tag className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-1">Sin listas de precios</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-6">
              Creá una lista (ej. "Salón", "Delivery") y asignale los canales que la usan.
            </p>
            {puedeEditar && (
              <Button onClick={() => setEditing('new')}>
                <Plus className="h-5 w-5 mr-1.5" />
                Crear primera lista
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {listas.map((l) => (
            <Card key={l.id} className="overflow-hidden">
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-lg font-semibold truncate">{l.nombre}</h3>
                      {l.atado_madre ? (
                        <Badge variant="violet">
                          <Link2 className="h-3 w-3 mr-1 inline" />
                          {Number(l.ajuste_madre_pct) > 0 ? '+' : ''}{Number(l.ajuste_madre_pct).toFixed(2)}% vs madre
                        </Badge>
                      ) : (
                        <Badge variant="gray">Precios independientes</Badge>
                      )}
                      {!l.activa && <Badge variant="gray">Inactiva</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {l.itemsCount} {l.itemsCount === 1 ? 'precio cargado' : 'precios cargados'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {puedeAsignar && (
                      <Button variant="outline" size="sm" onClick={() => setAsignando(l)}>
                        <Link2 className="h-4 w-4 mr-1.5" />
                        Canales
                      </Button>
                    )}
                    {puedeEditar && (
                      <Button variant="ghost" size="sm" onClick={() => setEditing(l)}>
                        <Pencil className="h-4 w-4 mr-1.5" />
                        Editar
                      </Button>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                  {l.canalesUsando.length === 0 ? (
                    <span className="text-xs text-muted-foreground italic">Ningún canal usa esta lista todavía</span>
                  ) : (
                    l.canalesUsando.map((c) => (
                      <span
                        key={c.id}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs font-medium"
                      >
                        <span>{c.emoji ?? '🛍️'}</span>
                        {c.nombre}
                      </span>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          ))}

          {canalesSinLista.length > 0 && (
            <Card className="border-amber-500/40 bg-amber-500/[0.04]">
              <CardContent className="p-4">
                <p className="text-sm font-medium mb-2">Canales sin lista asignada</p>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {canalesSinLista.map((c) => (
                    <span
                      key={c.id}
                      className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-background px-2.5 py-1 text-xs font-medium"
                    >
                      <span>{c.emoji ?? '🛍️'}</span>
                      {c.nombre}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Estos canales todavía no tienen una lista. Abrí una lista → "Canales" para asignarlos.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {editing && (
        <ListaForm
          user={user}
          lista={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}

      {asignando && (
        <AsignarCanalesDialog
          lista={asignando}
          canales={canales}
          onClose={() => setAsignando(null)}
          onSaved={() => { setAsignando(null); reload(); }}
        />
      )}
    </div>
  );
}

function ListaForm({ user, lista, onClose, onSaved }: {
  user: Usuario; lista: ListaPrecioConUso | null; onClose: () => void; onSaved: () => void;
}) {
  const [nombre, setNombre] = useState(lista?.nombre ?? '');
  const [atadoMadre, setAtadoMadre] = useState(lista?.atado_madre ?? true);
  const [ajustePct, setAjustePct] = useState<number>(lista?.ajuste_madre_pct ?? 0);
  const [redondeoA, setRedondeoA] = useState<number>(lista?.redondeo_a ?? 1);
  const [activa, setActiva] = useState(lista?.activa ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    const eN = validarNombre(nombre); if (eN) { setError(eN); return; }
    const eA = validarPorcentaje(ajustePct); if (eA) { setError(eA); return; }
    if (!user.tenant_id) { setError('Sin tenant'); return; }

    savingRef.current = true;
    setSaving(true);
    try {
      const draft: ListaPrecioDraft = {
        nombre: nombre.trim(),
        atado_madre: atadoMadre,
        ajuste_madre_pct: ajustePct,
        redondeo_a: redondeoA,
        activa,
      };
      const { error: err } = lista
        ? await updateListaPrecio(lista.id, draft)
        : await createListaPrecio(draft, user.tenant_id, null);
      if (err) { setError(err); return; }
      onSaved();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{lista ? 'Editar lista' : 'Nueva lista de precios'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="l-nombre">Nombre *</Label>
            <Input id="l-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)}
              required autoFocus placeholder="Salón · Delivery · Mostrador…" className="h-11" />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-primary" />
              <Label className="cursor-pointer">Atada al precio madre (recálculo automático)</Label>
            </div>
            <Switch checked={atadoMadre} onCheckedChange={setAtadoMadre} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="l-ajuste">Ajuste % vs madre</Label>
              <Input id="l-ajuste" type="number" step="0.01" value={ajustePct}
                onChange={(e) => setAjustePct(Number(e.target.value))}
                disabled={!atadoMadre} className="h-11 tabular-nums" />
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

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <Label className="cursor-pointer">Activa</Label>
            <Switch checked={activa} onCheckedChange={setActiva} />
          </div>

          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AsignarCanalesDialog({ lista, canales, onClose, onSaved }: {
  lista: ListaPrecioConUso; canales: Canal[]; onClose: () => void; onSaved: () => void;
}) {
  // Set local: qué canales quedan asignados a ESTA lista al confirmar.
  const [seleccion, setSeleccion] = useState<Set<number>>(
    () => new Set(canales.filter((c) => c.lista_precio_id === lista.id).map((c) => c.id)),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function toggle(canalId: number) {
    setSeleccion((prev) => {
      const next = new Set(prev);
      if (next.has(canalId)) next.delete(canalId); else next.add(canalId);
      return next;
    });
  }

  async function onConfirm() {
    setSaving(true);
    setError(null);
    // Diff: canales que hay que ATAR a esta lista, y canales que estaban en
    // esta lista y se destildaron (quedan sin lista → null).
    const cambios: Array<{ id: number; listaId: number | null }> = [];
    for (const c of canales) {
      const estaba = c.lista_precio_id === lista.id;
      const queda = seleccion.has(c.id);
      if (queda && !estaba) cambios.push({ id: c.id, listaId: lista.id });
      else if (!queda && estaba) cambios.push({ id: c.id, listaId: null });
    }
    for (const cambio of cambios) {
      const { error: err } = await setCanalLista(cambio.id, cambio.listaId);
      if (err) { setError(err); setSaving(false); return; }
    }
    setSaving(false);
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Canales que usan "{lista.nombre}"</DialogTitle>
          <DialogDescription>
            Tildá los canales que comparten esta lista. Un canal solo puede estar en una lista a la vez —
            si lo movés acá, sale de la que tenía.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5 max-h-[50vh] overflow-y-auto -mx-1 px-1">
          {canales.map((c) => {
            const sel = seleccion.has(c.id);
            const enOtra = c.lista_precio_id != null && c.lista_precio_id !== lista.id;
            return (
              <button
                type="button"
                key={c.id}
                onClick={() => toggle(c.id)}
                className={`w-full flex items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                  sel ? 'border-primary bg-primary/[0.06]' : 'border-border hover:bg-muted/40'
                }`}
              >
                <span className={`flex-shrink-0 flex items-center justify-center h-5 w-5 rounded border ${
                  sel ? 'bg-primary border-primary text-primary-foreground' : 'border-border'
                }`}>
                  {sel && <Check className="h-3.5 w-3.5" />}
                </span>
                <span className="text-lg flex-shrink-0">{c.emoji ?? '🛍️'}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium block truncate">{c.nombre}</span>
                  {enOtra && !sel && (
                    <span className="text-xs text-muted-foreground">usa otra lista</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {error && (
          <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button type="button" onClick={onConfirm} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
