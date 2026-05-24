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

// Evento custom para que TODOS los componentes que usen useLocalActivo se
// enteren cuando se cambia el local desde cualquier lugar. Antes (bug 24-may
// reportado por Lucas): el dropdown del sidebar cambiaba localId y escribía
// localStorage, pero el ReportesLayout (montado independiente) NO se
// enteraba — sus datos quedaban del local viejo. Fix: emitir CustomEvent al
// escribir + escuchar en el hook.
const LOCAL_CHANGED_EVENT = 'comanda:local-activo-changed';

export function writeLocalActivo(localId: number | null) {
  if (localId === null) localStorage.removeItem(LS_KEY);
  else localStorage.setItem(LS_KEY, String(localId));
  // Notificar a todos los useLocalActivo() activos en la misma tab.
  // (El evento nativo 'storage' solo se dispara entre tabs distintas, no
  // entre componentes de la misma tab.)
  try {
    window.dispatchEvent(new CustomEvent(LOCAL_CHANGED_EVENT, { detail: localId }));
  } catch { /* no-op si window no existe (SSR) */ }
}

// Hook: devuelve el local activo + setter. Default razonable según user.
//
// NOTA sprint 8 — auditoría 2026-05-07 marcó este effect como "potencial
// loop". Análisis: NO hay loop real bajo asumptions normales:
//   1. Lazy initializer del useState ya cubre el caso de user existente
//      al mount (calcula def y setea inicial).
//   2. El useEffect es defensive para el caso async: user llega DESPUÉS
//      del mount (login lento, refetch). Cuando llega:
//        - Effect corre con localId=null, user existe.
//        - Setea localId=def. Re-render.
//        - Effect re-corre (deps cambiaron). Ahora localId !== null →
//          if guard salta. NO LOOP.
//   3. setLocalId(null) manual nunca lo hacemos — el setter `set` solo
//      acepta `id: number`. Por lo tanto la transición localId=null →
//      def es one-way después del mount.
//
// El effect es redundante con el lazy init para el caso síncrono, pero
// hace falta para el caso async. Mantener.
export function useLocalActivo(user: Usuario | null): [number | null, (id: number) => void] {
  const [localId, setLocalId] = useState<number | null>(() => {
    const stored = readLocalActivo();
    if (stored !== null) return stored;
    if (user) {
      // Sprint Autónomo: user.locales puede ser null (= todos los locales del tenant).
      // admin POS sin restricción de locales → default 1 si no hay nada cargado.
      if (user.locales && user.locales.length > 0) return user.locales[0] ?? null;
      if (user.rol_pos === 'admin') return 1;
    }
    return null;
  });

  useEffect(() => {
    if (localId === null && user) {
      const first = (user.locales && user.locales[0]) ?? null;
      const def = first ?? (user.rol_pos === 'admin' ? 1 : null);
      if (def !== null) setLocalId(def);
    }
  }, [localId, user]);

  // Bug fix 24-may: cuando otro componente (típicamente el dropdown del
  // sidebar) llama writeLocalActivo(), todos los demás useLocalActivo()
  // activos en la misma tab deben actualizar su state. Sin este listener,
  // ReportesLayout seguía mostrando datos del local viejo aunque el
  // sidebar mostrara el nuevo.
  useEffect(() => {
    const handler = (e: Event) => {
      const newId = (e as CustomEvent<number | null>).detail;
      if (typeof newId === 'number' && newId !== localId) {
        setLocalId(newId);
      }
    };
    window.addEventListener(LOCAL_CHANGED_EVENT, handler);
    return () => window.removeEventListener(LOCAL_CHANGED_EVENT, handler);
  }, [localId]);

  const set = (id: number) => {
    writeLocalActivo(id);
    setLocalId(id);
  };

  return [localId, set];
}
