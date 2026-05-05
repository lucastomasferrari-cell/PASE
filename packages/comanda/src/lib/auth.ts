import { useEffect, useState } from 'react';
import { db } from './supabase';
import type { Usuario, Rol } from '../types/auth';

// ─── Permisos ──────────────────────────────────────────────────────────────
// Superadmin/dueño bypassan; el resto chequea contra usuario_permisos.

export function tienePermiso(user: Usuario | null, slug: string): boolean {
  if (!user) return false;
  if (user.rol === 'superadmin' || user.rol === 'dueno') return true;
  return user.permisos.includes(slug);
}

// ─── Hook de sesión ────────────────────────────────────────────────────────
// Carga usuario al montar + escucha onAuthStateChange. Hidrata permisos y
// locales del usuario en una sola query (paralelo).

interface AuthState {
  user: Usuario | null;
  loading: boolean;
  error: string | null;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ user: null, loading: true, error: null });

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
