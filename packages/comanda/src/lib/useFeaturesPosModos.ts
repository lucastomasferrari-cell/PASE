import { useEffect, useState } from 'react';
import { useAuth } from './auth';
import { useLocalActivo } from './localActivo';
import { getFeaturesPosModos } from '../services/configService';
import type { PosModo } from '../types/database';

const DEFAULT_MODOS: PosModo[] = ['salon', 'mostrador', 'pedidos'];

// Devuelve los modos POS habilitados para el local activo.
// Default los 3 si no se resolvió el local todavía o la query falla.
export function useFeaturesPosModos(): PosModo[] {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [modos, setModos] = useState<PosModo[]>(DEFAULT_MODOS);

  useEffect(() => {
    if (localId === null) return;
    let cancelled = false;
    getFeaturesPosModos(localId).then((m) => {
      if (!cancelled) setModos(m);
    });
    return () => { cancelled = true; };
  }, [localId]);

  return modos;
}
