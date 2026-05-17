// Sesión POS: empleado activo con PIN dentro de un local.
// Vive en sessionStorage (sobrevive refresh, muere al cerrar pestaña).
// Auto-lock por inactividad: cualquier interacción resetea el timer; al
// vencer se borra la sesión y se redirige al PinPad.
//
// Independiente de la sesión Supabase (Provider en lib/AuthProvider.tsx).
//
// Sprint 2 simplificación: PIN para TODOS los roles (incluido dueño). El
// "bypass dueño" se descartó porque el ID sintético rompía FKs hacia
// rrhh_empleados. El dueño se setea su propio empleado + PIN '0000' (o el
// que quiera) desde Settings → Empleados, y entra como cualquier otro.

import { createContext, useContext } from 'react';
import type { RolPos } from '../types/database';

export interface EmpleadoActivoPos {
  id: string;
  nombre: string;     // "Apellido Nombre"
  rol_pos: RolPos;
  local_id: number;
  desde: string;      // ISO timestamp del login
  // Sprint 16/05: Quick Items personales (item_ids favoritos del cajero/mozo)
  pos_favoritos?: number[];
}

export interface AuthPosState {
  empleado: EmpleadoActivoPos | null;
  loading: boolean;
}

export interface AuthPosActions {
  loginPin: (localId: number, pin: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  resetTimer: () => void;
  // Sprint 16/05: toggle Quick Item del empleado actual (item_id).
  // Persiste en DB + actualiza state local + storage.
  toggleFavorito: (itemId: number) => Promise<{ ok: boolean; error?: string }>;
}

export type AuthPosContextValue = AuthPosState & AuthPosActions;

const NOOP_ACTIONS: AuthPosActions = {
  loginPin: async () => ({ ok: false, error: 'Provider no montado' }),
  logout: () => {},
  resetTimer: () => {},
  toggleFavorito: async () => ({ ok: false, error: 'Provider no montado' }),
};

export const AuthPosContext = createContext<AuthPosContextValue>({
  empleado: null,
  loading: true,
  ...NOOP_ACTIONS,
});

export function useAuthPos(): AuthPosContextValue {
  return useContext(AuthPosContext);
}

// ─── sessionStorage helpers ────────────────────────────────────────────────

const SS_KEY = 'comanda.pos.empleado';

export function readEmpleadoFromStorage(): EmpleadoActivoPos | null {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as EmpleadoActivoPos;
  } catch {
    return null;
  }
}

export function writeEmpleadoToStorage(emp: EmpleadoActivoPos | null) {
  if (emp) sessionStorage.setItem(SS_KEY, JSON.stringify(emp));
  else sessionStorage.removeItem(SS_KEY);
}
