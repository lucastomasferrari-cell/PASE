// offline2 — provider que crea el store RxDB UNA sola vez para toda la app
// (resuelve el cuelgue de StrictMode que vimos en el spike: no inicializar el
// motor por componente). Al inicializar engancha el sync (pull + push vía RPCs).
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { crearOfflineDB, type OfflineDB } from './db';
import { startSync } from './sync';
import { uuidToTempId } from './tempId';
import { db as supa } from '../supabase';
import { RECONCILE_EVENT_NAME, type ReconcileEvent } from '../sync/idReconciliation';

const Ctx = createContext<OfflineDB | null>(null);

/** Devuelve el store local (null hasta que inicializa). */
// eslint-disable-next-line react-refresh/only-export-components -- provider + hook juntos (patrón estándar); el sync no se ve afectado.
export const useOfflineDb = (): OfflineDB | null => useContext(Ctx);

/**
 * Escucha cuando una venta local obtiene su `id` bigint real (vía el pull) y
 * emite `comanda:reconcile-id` {tempId, realId} para que la pantalla navegue de
 * `/pos/venta/-123` al id real. Reusa el bus que `useVentaData` ya escucha.
 */
function watchReconcile(db: OfflineDB): () => void {
  const emitidos = new Set<string>();
  const sub = db.ventas.find().$.subscribe((ventas) => {
    for (const v of ventas) {
      if (v.id != null && !emitidos.has(v.idempotency_uuid)) {
        emitidos.add(v.idempotency_uuid);
        if (typeof window === 'undefined') continue;
        const detail: ReconcileEvent = { kind: 'venta', tempId: uuidToTempId(v.idempotency_uuid), realId: v.id };
        window.dispatchEvent(new CustomEvent(RECONCILE_EVENT_NAME, { detail }));
      }
    }
  });
  return () => sub.unsubscribe();
}

export function OfflineProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<OfflineDB | null>(null);
  useEffect(() => {
    let cancel = false;
    let stop: (() => void) | null = null;
    let stopReconcile: (() => void) | null = null;
    crearOfflineDB().then((d) => {
      if (cancel) return;
      setDb(d);
      stop = startSync(d, supa); // pull incremental + push vía RPCs `_offline`
      stopReconcile = watchReconcile(d);
    });
    return () => { cancel = true; stop?.(); stopReconcile?.(); };
  }, []);
  return <Ctx.Provider value={db}>{children}</Ctx.Provider>;
}
