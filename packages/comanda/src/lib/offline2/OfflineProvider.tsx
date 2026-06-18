// offline2 — provider que crea el store RxDB UNA sola vez para toda la app
// (resuelve el cuelgue de StrictMode que vimos en el spike: no inicializar el
// motor por componente). El sync (pull + push vía RPCs) se engancha en Task 3.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { crearOfflineDB, type OfflineDB } from './db';

const Ctx = createContext<OfflineDB | null>(null);

/** Devuelve el store local (null hasta que inicializa). */
// eslint-disable-next-line react-refresh/only-export-components -- provider + hook juntos (patrón estándar); el sync no se ve afectado.
export const useOfflineDb = (): OfflineDB | null => useContext(Ctx);

export function OfflineProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<OfflineDB | null>(null);
  useEffect(() => {
    let cancel = false;
    crearOfflineDB().then((d) => { if (!cancel) setDb(d); });
    // TODO(Task 3): const stop = startSync(d); y limpiarlo acá.
    return () => { cancel = true; };
  }, []);
  return <Ctx.Provider value={db}>{children}</Ctx.Provider>;
}
