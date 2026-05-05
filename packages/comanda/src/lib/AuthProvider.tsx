import type { ReactNode } from 'react';
import { AuthContext, useAuthInternal } from './auth';

// AuthProvider: monta el hook real una sola vez. Todos los componentes que
// llamen useAuth() leen del mismo state (no se repite el fetch).
export function AuthProvider({ children }: { children: ReactNode }) {
  const state = useAuthInternal();
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
