import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Armchair, LayoutDashboard } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import {
  listMesas, createMesa, updateMesa, softDeleteMesa, updateMesaEditor, type MesaDraft,
} from '@/services/mesasService';
import type { Mesa, FormaMesa } from '@/types/database';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EstadoMesaBadge } from '@/components/EstadoBadge';
import { FloorPlanCanvas } from '@/components/FloorPlanCanvas';

const FORMAS: { value: FormaMesa; label: string }[] = [
  { value: 'cuadrado', label: 'Cuadrado' },
  { value: 'redondo', label: 'Redondo' },
  { value: 'rectangular', label: 'Rectangular' },
];

export function SettingsMesas() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [mesas, setMesas] = useState<Mesa[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Mesa | 'new' | null>(null);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const { data } = await listMesas(localId);
    setMesas(data);
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);
  useRealtimeTable({ table: 'mesas', onChange: () => reload() });

  const filtered = mesas.filter((m) =>
    !search || m.numero.toLowerCase().includes(search.toLowerCase()) || (m.zona ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  async function handleMesaMoved(id: number, x: number, y: number) {
    setSaving(id);
    const { error } = await updateMesaEditor(id, { pos_x: x, pos_y: y });
    setSaving(null);
    if (error) toast.error('Error guardando posición: ' + error);
    else {
      setMesas((prev) => prev.map((m) => m.id === id ? { ...m, pos_x: x, pos_y: y } : m));
    }
  }

  return (
    <div>
      <Tabs defaultValue="lista">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <TabsList>
            <TabsTrigger value="lista">Lista</TabsTrigger>
            <TabsTrigger value="plano">
              <LayoutDashboard className="h-3.5 w-3.5 mr-1.5" />
              Plano del salón
            </TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar mesa…"
              className="max-w-[180px] h-9"
            />
            <Button onClick={() => setEditing('new')} size="sm">
              <Plus className="h-4 w-4 mr-1" />
              Nueva mesa
            </Button>
          </div>
        </div>

        {/* Tab: Lista */}
        <TabsContent value="lista" className="mt-0">
          {loading ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground">Cargando…</CardContent></Card>
          ) : filtered.length === 0 ? (
            <Card><CardContent className="py-16 text-center">
              <Armchair className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <h3 className="text-lg font-medium mb-1">Sin mesas</h3>
              <p className="text-sm text-muted-foreground mb-4">Agregá las mesas del salón.</p>
              <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4 mr-2" />Crear primera mesa</Button>
            </CardContent></Card>
          ) : (
            <Card className="overflow-hidden">
              <div className="grid grid-cols-[120px_1fr_120px_120px_120px_120px] gap-4 px-6 py-3 border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                <div>Número</div><div>Zona</div><div>Capacidad</div><div>Forma</div><div>Estado</div><div className="text-right">Acciones</div>
              </div>
              {filtered.map((m, idx) => (
                <div key={m.id} className={`grid grid-cols-[120px_1fr_120px_120px_120px_120px] gap-4 px-6 py-3 items-center text-sm ${idx !== filtered.length - 1 ? 'border-b border-border' : ''}`}>
                  <div className="font-semibold">{m.numero}</div>
                  <div className="text-muted-foreground">{m.zona ?? '—'}</div>
                  <div className="text-muted-foreground">{m.capacidad ?? '—'}</div>
                  <div className="text-muted-foreground capitalize">{m.forma}</div>
                  <div><EstadoMesaBadge estado={m.estado} /></div>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(m)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost" size="sm"
                      className="text-destructive hover:bg-destructive/10"
                      onClick={async () => {
                        if (!confirm(`¿Borrar mesa ${m.numero}?`)) return;
                        const { error } = await softDeleteMesa(m.id);
                        if (error) toast.error(error);
                        else { toast.success('Mesa borrada'); reload(); }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </TabsContent>

        {/* Tab: Plano (editor drag-drop) */}
        <TabsContent value="plano" className="mt-0">
          {loading ? (
            <div className="py-12 text-center text-muted-foreground">Cargando…</div>
          ) : mesas.length === 0 ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground">
              Primero creá las mesas desde la pestaña Lista.
            </CardContent></Card>
          ) : (
            <>
              {saving !== null && (
                <p className="text-xs text-muted-foreground mb-2">Guardando posición…</p>
              )}
              <FloorPlanCanvas
                mesas={mesas}
                readonly={false}
                onMesaMoved={handleMesaMoved}
              />
            </>
          )}
        </TabsContent>
      </Tabs>

      {editing && localId !== null && (
        <MesaDialog
          mesa={editing === 'new' ? null : editing}
          tenantId={user?.tenant_id ?? ''}
          localId={localId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

function MesaDialog({ mesa, tenantId, localId, onClose, onSaved }: {
  mesa: Mesa | null;
  tenantId: string;
  localId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [numero, setNumero] = useState(mesa?.numero ?? '');
  const [zona, setZona] = useState(mesa?.zona ?? '');
  const [capacidad, setCapacidad] = useState(mesa?.capacidad ?? 4);
  const [forma, setForma] = useState<FormaMesa>(mesa?.forma ?? 'cuadrado');
  const [saving, setSaving] = useState(false);

  async function guardar() {
    if (!numero.trim()) { toast.error('Número requerido'); return; }
    setSaving(true);
    const draft: MesaDraft = {
      tenant_id: tenantId, local_id: localId,
      numero: numero.trim(),
      zona: zona.trim() || null,
      capacidad,
      forma,
    };
    const { error } = mesa ? await updateMesa(mesa.id, draft) : await createMesa(draft);
    setSaving(false);
    if (error) { toast.error(error); return; }
    toast.success(mesa ? 'Mesa actualizada' : 'Mesa creada');
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{mesa ? 'Editar mesa' : 'Nueva mesa'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Número *</Label>
              <Input value={numero} onChange={(e) => setNumero(e.target.value)} className="h-11" autoFocus />
            </div>
            <div className="space-y-2">
              <Label>Zona</Label>
              <Input value={zona} onChange={(e) => setZona(e.target.value)} placeholder="Salón / Terraza / Barra" className="h-11" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Capacidad</Label>
              <Input type="number" min={1} max={20} value={capacidad}
                onChange={(e) => setCapacidad(Number(e.target.value))} className="h-11" />
            </div>
            <div className="space-y-2">
              <Label>Forma</Label>
              <Select value={forma} onValueChange={(v) => setForma(v as FormaMesa)}>
                <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FORMAS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
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
