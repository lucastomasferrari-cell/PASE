import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, CreditCard, Pencil } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import {
  listMetodos, createMetodo, updateMetodo, softDeleteMetodo, toggleActivo,
  type MetodoDraft,
} from '@/services/metodosCobroService';
import type { MetodoCobro } from '@/types/database';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

export function SettingsMetodosCobro() {
  const { user } = useAuth();
  const [metodos, setMetodos] = useState<MetodoCobro[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<MetodoCobro | 'new' | null>(null);

  const reload = useCallback(async () => {
    if (!user?.tenant_id) return;
    setLoading(true);
    const { data } = await listMetodos(user.tenant_id);
    setMetodos(data);
    setLoading(false);
  }, [user?.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted-foreground">{metodos.length} métodos</p>
        <Button onClick={() => setEditing('new')} size="lg">
          <Plus className="h-5 w-5" />
          Nuevo método
        </Button>
      </div>

      {loading ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Cargando…</CardContent></Card>
      ) : metodos.length === 0 ? (
        <Card><CardContent className="py-16 text-center">
          <CreditCard className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="text-lg font-medium mb-1">Sin métodos de cobro</h3>
          <p className="text-sm text-muted-foreground">Cargá los métodos que usás (Efectivo, MP, Tarjeta, etc.)</p>
        </CardContent></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[80px_1fr_140px_120px_140px_140px] gap-4 px-6 py-3 border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <div>Orden</div><div>Método</div><div>Slug</div><div>Pide vuelto</div><div>Activo</div><div className="text-right">Acciones</div>
          </div>
          {metodos.map((m, idx) => (
            <div key={m.id} className={`grid grid-cols-[80px_1fr_140px_120px_140px_140px] gap-4 px-6 py-3 items-center text-sm ${idx !== metodos.length - 1 ? 'border-b border-border' : ''}`}>
              <div className="text-muted-foreground tabular-nums">{m.orden}</div>
              <div>
                <span className="mr-1.5">{m.emoji}</span>
                <strong>{m.nombre}</strong>
              </div>
              <div className="text-xs text-muted-foreground font-mono">{m.slug}</div>
              <div>{m.pide_vuelto ? 'Sí' : 'No'}</div>
              <div>
                <Switch
                  checked={m.activo}
                  onCheckedChange={async (v) => {
                    const { error } = await toggleActivo(m.id, v);
                    if (error) toast.error(error); else { toast.success(v ? 'Activado' : 'Desactivado'); reload(); }
                  }}
                />
              </div>
              <div className="flex justify-end gap-1">
                <Button variant="ghost" size="sm" onClick={() => setEditing(m)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10"
                  onClick={async () => {
                    if (!confirm(`¿Borrar método "${m.nombre}"?`)) return;
                    const { error } = await softDeleteMetodo(m.id);
                    if (error) toast.error(error); else { toast.success('Borrado'); reload(); }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      {editing && (
        <MetodoDialog
          metodo={editing === 'new' ? null : editing}
          tenantId={user?.tenant_id ?? ''}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

function MetodoDialog({ metodo, tenantId, onClose, onSaved }: {
  metodo: MetodoCobro | null;
  tenantId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [nombre, setNombre] = useState(metodo?.nombre ?? '');
  const [slug, setSlug] = useState(metodo?.slug ?? '');
  const [emoji, setEmoji] = useState(metodo?.emoji ?? '💵');
  const [pideVuelto, setPideVuelto] = useState(metodo?.pide_vuelto ?? false);
  const [activo, setActivo] = useState(metodo?.activo ?? true);
  const [orden, setOrden] = useState(metodo?.orden ?? 99);
  const [saving, setSaving] = useState(false);

  async function guardar() {
    if (!nombre.trim()) { toast.error('Nombre requerido'); return; }
    if (!/^[a-z0-9_-]+$/.test(slug.trim())) { toast.error('Slug inválido (solo a-z, 0-9, _, -)'); return; }
    setSaving(true);
    const draft: MetodoDraft = {
      tenant_id: tenantId, local_id: null,
      nombre: nombre.trim(), slug: slug.trim(), emoji, pide_vuelto: pideVuelto, activo, orden,
    };
    const { error } = metodo ? await updateMetodo(metodo.id, draft) : await createMetodo(draft);
    setSaving(false);
    if (error) { toast.error(error); return; }
    toast.success(metodo ? 'Actualizado' : 'Creado');
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{metodo ? 'Editar método' : 'Nuevo método de cobro'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-[80px_1fr] gap-3">
            <div className="space-y-2">
              <Label>Emoji</Label>
              <Input value={emoji} onChange={(e) => setEmoji(e.target.value)} className="h-11 text-center text-xl" maxLength={2} />
            </div>
            <div className="space-y-2">
              <Label>Nombre *</Label>
              <Input value={nombre} onChange={(e) => setNombre(e.target.value)} className="h-11" autoFocus />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Slug *</Label>
              <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="mp_qr" className="h-11" />
            </div>
            <div className="space-y-2">
              <Label>Orden</Label>
              <Input type="number" value={orden} onChange={(e) => setOrden(Number(e.target.value))} className="h-11" />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <Label>Pide vuelto</Label>
            <Switch checked={pideVuelto} onCheckedChange={setPideVuelto} />
          </div>
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <Label>Activo</Label>
            <Switch checked={activo} onCheckedChange={setActivo} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={guardar} disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
