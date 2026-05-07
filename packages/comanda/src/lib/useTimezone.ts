import { useEffect, useState } from 'react';
import { useLocalActivo } from './localActivo';
import { useAuth } from './auth';
import { db } from './supabase';
import { DEFAULT_TIMEZONE } from './format';

// Sprint 8 tarea 3: hook que devuelve la zona horaria del local activo.
// Default Buenos Aires si no hay local o no hay settings cargados.
//
// Uso típico:
//   const tz = useTimezone();
//   <span>{formatFecha(iso, tz)}</span>
//
// Cache: se almacena en state local del componente. Si N componentes
// llaman useTimezone simultáneamente, hay N requests al mount. Si esto
// se vuelve costoso (tab con muchos componentes), refactor a un único
// store global (Zustand custom o similar). Anotado en DEUDA.
export function useTimezone(): string {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [tz, setTz] = useState<string>(DEFAULT_TIMEZONE);

  useEffect(() => {
    if (localId === null) {
      setTz(DEFAULT_TIMEZONE);
      return;
    }
    let cancelled = false;
    db.from('comanda_local_settings')
      .select('timezone')
      .eq('local_id', localId)
      .is('deleted_at', null)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) return;
        const fetched = (data as { timezone?: string | null }).timezone;
        setTz(fetched || DEFAULT_TIMEZONE);
      });
    return () => { cancelled = true; };
  }, [localId]);

  return tz;
}
