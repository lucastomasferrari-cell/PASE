import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Flame, Clock } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

// Botón en el header del POS para activar/desactivar "Busy Mode".
// Cuando la cocina está saturada, el dueño/encargado clickea acá y
// elige cuánto extra y por cuánto tiempo. La tienda online + marketplace
// muestran tiempos más realistas. Vuelve a normal automático al vencer.
//
// Estilo Deliverect/Otter — botón pánico para sábado 21:30 con 40 tickets.

interface Settings {
  busy_extra_min: number;
  busy_hasta: string | null;
}

const PRESETS = [
  { extra: 10, duracion: 60, label: '+10 min por 1 hora' },
  { extra: 15, duracion: 60, label: '+15 min por 1 hora' },
  { extra: 20, duracion: 90, label: '+20 min por 1:30' },
  { extra: 30, duracion: 120, label: '+30 min por 2 horas' },
];

export function BusyModeButton() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (localId === null) return;
    // eslint-disable-next-line pase-local/require-apply-local-scope -- query directa por PK
    const { data } = await db
      .from('comanda_local_settings')
      .select('busy_extra_min, busy_hasta')
      .eq('local_id', localId)
      .single();
    if (data) setSettings(data as Settings);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  // Tick cada 30s para refrescar el "vuelve en X min"
  useEffect(() => {
    const id = setInterval(reload, 30_000);
    return () => clearInterval(id);
  }, [reload]);

  const activo = settings?.busy_hasta != null && new Date(settings.busy_hasta).getTime() > Date.now();
  const minRestantes = activo && settings?.busy_hasta
    ? Math.max(0, Math.ceil((new Date(settings.busy_hasta).getTime() - Date.now()) / 60_000))
    : 0;

  async function setBusy(extra: number, duracion: number) {
    if (localId === null) return;
    setLoading(true);
    const { error } = await db.rpc('fn_set_busy_mode', {
      p_local_id: localId,
      p_extra_min: extra,
      p_minutos_duracion: duracion,
    });
    setLoading(false);
    if (error) { toast.error(error.message); return; }
    if (extra === 0 || duracion === 0) {
      toast.success('Busy Mode desactivado');
    } else {
      toast.success(`Busy Mode activado: +${extra} min por ${duracion} min`);
    }
    reload();
  }

  if (localId === null) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'h-8 w-8 rounded-md flex items-center justify-center transition-colors',
            activo
              ? 'text-destructive bg-destructive/10 hover:bg-destructive/20 animate-pulse'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
          title={activo
            ? `Busy Mode activo: +${settings?.busy_extra_min}min por ${minRestantes} min más`
            : 'Bumpear tiempos de prep informados al cliente (cocina saturada)'}
        >
          <Flame className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs">
          {activo
            ? `Activo: cliente ve +${settings?.busy_extra_min}min extra`
            : 'Cocina saturada — informá al cliente'}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {PRESETS.map((p) => (
          <DropdownMenuItem
            key={p.label}
            onClick={() => setBusy(p.extra, p.duracion)}
            disabled={loading}
          >
            <Clock className="h-3.5 w-3.5 mr-2" />
            {p.label}
          </DropdownMenuItem>
        ))}
        {activo && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setBusy(0, 0)} disabled={loading} className="text-success">
              ✓ Desactivar Busy Mode
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
