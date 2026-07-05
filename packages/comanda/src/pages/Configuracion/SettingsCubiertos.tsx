import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Save, Utensils, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

// Configuración del cubierto por sector.
// - Lee mesas.zona distinct del local + rows de comanda_cubiertos_config.
// - Une ambas para presentar tabla editable (zonas sin config se muestran
//   como filas nuevas con precio 0 + inactivas).
// - Guardado en batch via upsert (una row por (local_id, zona)).
// - Permite agregar zonas custom (útil si el dueño quiere "Terraza VIP" o algo
//   que todavía no existe en mesas).

interface ConfigRow {
  id?: number;         // undefined si es nueva (aún no persistida)
  zona: string;
  precio: number;
  activo: boolean;
  esNueva?: boolean;   // agregada en la UI, todavía no está en DB
  esExtra?: boolean;   // sin mesas asignadas (zona custom o zona borrada)
}

export function SettingsCubiertos() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [rows, setRows] = useState<ConfigRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nuevaZona, setNuevaZona] = useState('');

  useEffect(() => {
    if (!localId) return;
    setLoading(true);
    Promise.all([
      db.from('mesas').select('zona').eq('local_id', localId).is('deleted_at', null),
      db.from('comanda_cubiertos_config').select('id, zona, precio, activo').eq('local_id', localId),
    ]).then(([mesasRes, cfgRes]) => {
      const zonasMesas = new Set<string>();
      for (const m of mesasRes.data ?? []) {
        const z = (m as { zona: string | null }).zona;
        if (z && z.trim()) zonasMesas.add(z);
      }
      const zonasConfig = new Map<string, { id: number; precio: number; activo: boolean }>();
      for (const c of cfgRes.data ?? []) {
        const r = c as { id: number; zona: string; precio: string | number; activo: boolean };
        zonasConfig.set(r.zona, { id: r.id, precio: Number(r.precio), activo: r.activo });
      }
      const all = new Set<string>([...zonasMesas, ...zonasConfig.keys()]);
      const list: ConfigRow[] = [...all].sort().map((zona) => {
        const cfg = zonasConfig.get(zona);
        return {
          id: cfg?.id,
          zona,
          precio: cfg?.precio ?? 0,
          activo: cfg?.activo ?? false,
          esExtra: !zonasMesas.has(zona),
        };
      });
      setRows(list);
      setLoading(false);
    });
  }, [localId]);

  const totalActivas = useMemo(() => rows.filter((r) => r.activo && r.precio > 0).length, [rows]);

  function updateRow(idx: number, patch: Partial<ConfigRow>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function agregarZona() {
    const z = nuevaZona.trim();
    if (!z) return;
    if (rows.some((r) => r.zona.toLowerCase() === z.toLowerCase())) {
      toast.error('Esa zona ya está en la lista');
      return;
    }
    setRows((prev) => [...prev, { zona: z, precio: 0, activo: false, esNueva: true, esExtra: true }]);
    setNuevaZona('');
  }

  function eliminarZona(idx: number) {
    const row = rows[idx];
    if (!row) return;
    if (row.id === undefined) {
      // Solo estaba en la UI, la sacamos y listo.
      setRows((prev) => prev.filter((_, i) => i !== idx));
      return;
    }
    // Fila persistida: la borramos de DB y del estado local.
    db.from('comanda_cubiertos_config').delete().eq('id', row.id).then(({ error }) => {
      if (error) { toast.error('No se pudo borrar'); return; }
      setRows((prev) => prev.filter((_, i) => i !== idx));
      toast.success('Zona eliminada');
    });
  }

  async function guardar() {
    if (!localId || !user?.tenant_id) return;
    setSaving(true);
    // Upsert por (local_id, zona) — la unique key en la tabla lo hace atómico.
    const payload = rows.map((r) => ({
      tenant_id: user.tenant_id,
      local_id: localId,
      zona: r.zona,
      precio: r.precio,
      activo: r.activo,
    }));
    const { error } = await db.from('comanda_cubiertos_config').upsert(payload, {
      onConflict: 'local_id,zona',
    });
    setSaving(false);
    if (error) toast.error(error.message);
    else toast.success('Cubiertos guardados');
  }

  if (loading) {
    return <div className="container max-w-3xl py-8 text-center text-muted-foreground">Cargando…</div>;
  }

  return (
    <div className="container max-w-3xl py-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Utensils className="h-5 w-5" />
          Cubierto por sector
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Cuando se abre una mesa, el cubierto se suma automáticamente como ítem visible en la
          comanda (cantidad = comensales × precio del sector). Se anula con PIN manager igual
          que cualquier otro ítem.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span>Sectores del local</span>
            <span className="text-xs font-normal text-muted-foreground">
              {totalActivas} activo{totalActivas === 1 ? '' : 's'}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {rows.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No hay sectores todavía. Agregá abajo (ej: Salón, Barra, Terraza).
            </p>
          )}
          {rows.map((row, idx) => (
            <div
              key={row.zona}
              className="grid grid-cols-[1fr_140px_auto_auto] items-center gap-3 py-2 border-b border-border/60 last:border-0"
            >
              <div className="min-w-0">
                <div className="font-medium text-sm truncate">{row.zona}</div>
                {row.esExtra && (
                  <div className="text-[11px] text-muted-foreground">Sin mesas asignadas</div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">$</span>
                <Input
                  type="number"
                  min={0}
                  step={100}
                  value={row.precio}
                  onChange={(e) => updateRow(idx, { precio: Number(e.target.value) || 0 })}
                  className="h-9 text-right tabular-nums"
                  disabled={!row.activo}
                />
              </div>
              <Switch
                checked={row.activo}
                onCheckedChange={(v) => updateRow(idx, { activo: !!v })}
                aria-label={`Activar cubierto en ${row.zona}`}
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => eliminarZona(idx)}
                title="Eliminar zona"
                className="h-9 w-9"
              >
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          ))}

          <div className="pt-3 border-t border-border/60">
            <Label className="text-xs text-muted-foreground">Agregar sector nuevo</Label>
            <div className="flex gap-2 mt-1.5">
              <Input
                value={nuevaZona}
                onChange={(e) => setNuevaZona(e.target.value)}
                placeholder="Ej: Salón VIP"
                className="h-9"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); agregarZona(); } }}
              />
              <Button variant="outline" size="sm" onClick={agregarZona} disabled={!nuevaZona.trim()}>
                <Plus className="h-4 w-4 mr-1" />
                Agregar
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-2 sticky bottom-0 bg-background/95 backdrop-blur py-3">
        <p className="text-xs text-muted-foreground">
          Ejemplo: 4 comensales en Salón con cubierto $500 → +$2.000 automático.
          {totalActivas === 0 && ' Ningún sector activo hoy.'}
        </p>
        <Button onClick={guardar} disabled={saving}>
          <Save className="h-4 w-4 mr-1.5" />
          {saving ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </div>
  );
}
