// offline2 — provider que crea el store RxDB UNA sola vez para toda la app
// (resuelve el cuelgue de StrictMode que vimos en el spike: no inicializar el
// motor por componente). Al inicializar engancha el sync (pull + push vía RPCs).
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { crearOfflineDB, type OfflineDB } from './db';
import { startSync } from './sync';
import { db as supa } from '../supabase';

const Ctx = createContext<OfflineDB | null>(null);

/** Devuelve el store local (null hasta que inicializa). */
// eslint-disable-next-line react-refresh/only-export-components -- provider + hook juntos (patrón estándar); el sync no se ve afectado.
export const useOfflineDb = (): OfflineDB | null => useContext(Ctx);

export function OfflineProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<OfflineDB | null>(null);
  useEffect(() => {
    let cancel = false;
    let stop: (() => void) | null = null;
    crearOfflineDB().then((d) => {
      if (cancel) return;
      setDb(d);
      stop = startSync(d, supa); // pull incremental + push vía RPCs `_offline`
    });
    return () => { cancel = true; stop?.(); };
  }, []);
  return <Ctx.Provider value={db}>{children}</Ctx.Provider>;
}
