// SyncEngineLifecycle — wirea el syncEngine al ciclo de vida del usuario
// logueado + local activo. Componente sin UI; solo side-effects.
//
// Reglas:
//   1. Engine arranca cuando: user logueado + localActivo set + flag
//      offlineFirstVentas=ON.
//   2. Si localActivo cambia: stop + start con el nuevo contexto.
//   3. Si user hace logout: stop.
//   4. Si flag se apaga (toggle off + reload): no arranca.
//   5. Listeners de window 'online'/'offline' notifican al engine.
//
// Montar UNA sola vez en App.tsx dentro del AuthProvider + Router. No
// renderiza nada.

import { useEffect } from 'react';
import { useAuth } from '../auth';
import { useLocalActivo } from '../localActivo';
import { featureFlags } from '../featureFlags';
import { syncEngine } from './syncEngine';

export function SyncEngineLifecycle() {
  const { user } = useAuth();
  const [localActivo] = useLocalActivo(user);
  const flagOn = featureFlags.offlineFirstVentas;

  useEffect(() => {
    if (!flagOn) return;
    if (!user?.tenant_id || localActivo == null) return;

    let stopped = false;
    void syncEngine.start({ tenantId: user.tenant_id, localId: localActivo })
      .catch((err) => {
        // No crashear la app — el engine entra en estado error y la UI
        // (banner futuro) lo muestra. Loggeamos a consola para debug.
        if (!stopped) {
          console.error('[syncEngine] start failed:', err);
        }
      });

    // Online/offline listeners: el engine reacciona para reanudar push.
    const onOnline = () => { void syncEngine.notifyOnline(); };
    const onOffline = () => { syncEngine.notifyOffline(); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      stopped = true;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      syncEngine.stop();
    };
  }, [flagOn, user?.tenant_id, localActivo]);

  return null;
}
