// Local activo: el local con el que el usuario está operando POS.
// Persiste en localStorage. Si no hay valor, devuelve el primero de
// user.locales o local_id=1 como fallback razonable.

import { useEffect, useState } from 'react';
import type { Usuario } from '../types/auth';

const LS_KEY = 'comanda.local_activo';

export function readLocalActivo(): number | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeLocalActivo(localId: number | null) {
  if (localId === null) localStorage.removeItem(LS_KEY);
  else localStorage.setItem(LS_KEY, String(localId));
}

// Hook: devuelve el local activo + setter. Default razonable según user.
export function useLocalActivo(user: Usuario | null): [number | null, (id: number) => void] {
  const [localId, setLocalId] = useState<number | null>(() => {
    const stored = readLocalActivo();
    if (stored !== null) return stored;
    if (user) {
      if (user.locales.length > 0) return user.locales[0] ?? null;
      // dueño/superadmin sin locales asignados → default 1
      if (user.rol === 'superadmin' || user.rol === 'dueno') return 1;
    }
    return null;
  });

  useEffect(() => {
    if (localId === null && user) {
      const def = user.locales[0] ?? (user.rol === 'superadmin' || user.rol === 'dueno' ? 1 : null);
      if (def !== null) setLocalId(def);
    }
  }, [localId, user]);

  const set = (id: number) => {
    writeLocalActivo(id);
    setLocalId(id);
  };

  return [localId, set];
}
