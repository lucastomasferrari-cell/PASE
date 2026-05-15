import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { ChefHat } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ESTACIONES, type EstacionKds } from '@/services/kdsTokensService';
import { useRealtimeTable } from '@/lib/useRealtimeTable';

interface GrupoConEstacion {
  id: number;
  nombre: string;
  emoji: string | null;
  estacion_default: EstacionKds | null;
}

export function SettingsEstaciones() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [grupos, setGrupos] = useState<GrupoConEstacion[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!user?.tenant_id) return;
    setLoading(true);
    let q = db.from('item_grupos').select('id,nombre,emoji,estacion_default,local_id').is('deleted_at', null).order('nombre');
    if (localId != null) q = q.or(`local_id.eq.${localId},local_id.is.null`);
    const { data, error } = await q;
    if (error) { toast.error(error.message); setLoading(false); return; }
    setGrupos((data ?? []) as GrupoConEstacion[]);
    setLoading(false);
  }, [localId, user?.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  useRealtimeTable({ table: 'item_grupos', onChange: () => reload() });

  async function asignar(grupoId: number, estacion: EstacionKds) {
    const { error } = await db.from('item_grupos').update({ estacion_default: estacion }).eq('id', grupoId);
    if (error) { toast.error(error.message); return; }
    toast.success('Estación actualizada');
    setGrupos(g => g.map(x => x.id === grupoId ? { ...x, estacion_default: estacion } : x));
  }

  return (
    <Card>
      <CardContent className="p-6 space-y-3">
        <header>
          <h2 className="text-base font-semibold flex items-center gap-2"><ChefHat className="h-4 w-4" /> Estaciones por grupo</h2>
          <p className="text-xs text-muted-foreground">Cada grupo va a una estación de cocina por defecto. Los items lo heredan; pueden sobrescribir desde el editor de items.</p>
        </header>
        {loading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : grupos.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin grupos cargados.</p>
        ) : (
          <div className="space-y-2">
            {grupos.map(g => (
              <div key={g.id} className="rounded-md border border-border p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {g.emoji ? `${g.emoji} ` : ''}{g.nombre}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Asignado a: {ESTACIONES.find(e => e.id === g.estacion_default)?.label ?? '—'}
                  </div>
                </div>
                <Select value={g.estacion_default ?? 'cocina_caliente'} onValueChange={v => asignar(g.id, v as EstacionKds)}>
                  <SelectTrigger className="w-[180px] h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ESTACIONES.map(e => (
                      <SelectItem key={e.id} value={e.id}>{e.emoji} {e.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
