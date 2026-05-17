// React hook que expone el estado del syncEngine + helper para trigger
// manual de push.
//
// Uso típico:
//
//   const { state, triggerPush } = useSync();
//   if (state.kind === 'offline') return <BannerOffline />;
//   if (state.kind === 'error') return <BannerError msg={state.message} />;
//
// El componente SyncStatus en components/ ya usa esto + estilos.

import { useEffect, useState, useCallback } from 'react';
import { syncEngine, type SyncState } from './syncEngine';

export function useSync() {
  const [state, setState] = useState<SyncState>(syncEngine.getState());

  useEffect(() => {
    return syncEngine.subscribe(setState);
  }, []);

  const triggerPush = useCallback(async () => {
    await syncEngine.triggerPush();
  }, []);

  return { state, triggerPush };
}
