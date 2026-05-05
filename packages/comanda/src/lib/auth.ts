import { createContext, useContext, useEffect, useState } from 'react';
import { db } from './supabase';
import type { Usuario, Rol } from '../types/auth';

// ─── Permisos ──────────────────────────────────────────────────────────────
// Superadmin/dueño bypassan; el resto chequea contra usuario_permisos.

export function tienePermiso(user: Usuario | null, slug: string): boolean {
  if (!user) return false;
  if (user.rol === 'superadmin' || user.rol === 'dueno') return true;
  return user.permisos.includes(slug);
}

// ─── Sesión ────────────────────────────────────────────────────────────────
// El estado vive en un Context inicializado por <AuthProvider>. Los componentes
// llaman useAuth() (lee del context). El hook useAuthInternal (no exportado)
// hace el fetch real una sola vez por sesión.

export interface AuthState {
  user: Usuario | null;
  loading: boolean;
  error: string | null;
}

const INITIAL: AuthState = { user: null, loading: true, error: null };

export const AuthContext = createContext<AuthState>(INITIAL);

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

// useAuthInternal: hook que vive dentro del AuthProvider. No usar directamente
// desde componentes de pantalla — usar useAuth().
export function useAuthInternal(): AuthState {
  const [state, setState] = useState<AuthState>(INITIAL);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const { data: sessionData } = await db.auth.getSession();
      const authId = sessionData.session?.user?.id;
      if (!authId) {
        if (mounted) setState({ user: null, loading: false, error: null });
        return;
      }

      const { data: rows, error } = await db
        .from('usuarios')
        .select('id, auth_id, email, nombre, rol, activo, tenant_id')
        .eq('auth_id', authId)
        .eq('activo', true)
        .limit(1);

      if (error) {
        if (mounted) setState({ user: null, loading: false, error: error.message });
        return;
      }
      const row = rows?.[0];
      if (!row) {
        if (mounted) setState({ user: null, loading: false, error: 'Usuario no encontrado' });
        return;
      }

      const [permsRes, localesRes] = await Promise.all([
        db.from('usuario_permisos').select('modulo_slug').eq('usuario_id', row.id),
        db.from('usuario_locales').select('local_id').eq('usuario_id', row.id),
      ]);

      const permisos = (permsRes.data ?? []).map((p) => p.modulo_slug as string);
      const locales = (localesRes.data ?? [])
        .map((l) => l.local_id as number | null)
        .filter((n): n is number => typeof n === 'number');

      const user: Usuario = {
        id: row.id as number,
        auth_id: row.auth_id as string,
        email: row.email as string | null,
        nombre: row.nombre as string,
        rol: row.rol as Rol,
        activo: row.activo as boolean,
        tenant_id: row.tenant_id as string | null,
        permisos,
        locales,
      };
      if (mounted) setState({ user, loading: false, error: null });
    }

    load();

    const { data: sub } = db.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        if (mounted) setState({ user: null, loading: false, error: null });
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        load();
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
