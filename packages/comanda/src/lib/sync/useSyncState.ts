// Hook React para suscribirse al estado del syncEngine. Re-renderea el
// caller cada vez que el engine cambia de estado (idle/pulling/pushing/
// error/offline) o cambia el contador de ops pendientes.
//
// Útil para mostrar un badge o banner: "Sincronizando…", "12 ops pendientes",
// "Sin conexión — los cobros se guardan local", etc.

import { useEffect, useState } from 'react';
import { syncEngine, type SyncState } from './syncEngine';

export function useSyncState(): SyncState {
  const [state, setState] = useState<SyncState>(() => syncEngine.getState());

  useEffect(() => {
    return syncEngine.subscribe(setState);
  }, []);

  return state;
}
