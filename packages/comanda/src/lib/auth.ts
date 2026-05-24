import { createContext, useContext, useEffect, useState } from 'react';
import { db } from './supabase';
import type { Usuario, RolPos } from '../types/auth';

// ─── Permisos ──────────────────────────────────────────────────────────────
// Sprint COMANDA Autónomo Fase 3 (24-may):
// - rol_pos='admin' bypassa todos los chequeos (acceso total POS).
// - El resto: chequea contra `comanda_usuario_permisos` (slugs comanda.*).
// - Roles 'superadmin' / 'dueno' de PASE NO aplican acá — son ortogonales.

export function tienePermiso(user: Usuario | null, slug: string): boolean {
  if (!user) return false;
  if (user.rol_pos === 'admin') return true;
  return user.permisos.includes(slug);
}

// ─── Sesión ────────────────────────────────────────────────────────────────
// El user logueado proviene de `comanda_usuarios` (no de `usuarios` de PASE).
// Si el email tiene cuenta PASE pero no tiene fila en comanda_usuarios, NO
// puede entrar a COMANDA — se le muestra error "Sin acceso a COMANDA".

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

      // ─── Cargar perfil COMANDA por auth_id (no PASE) ──────────────────
      const { data: rows, error } = await db
        .from('comanda_usuarios')
        .select('id, auth_id, email, nombre, rol_pos, activo, tenant_id, locales, pin_pos')
        .eq('auth_id', authId)
        .eq('activo', true)
        .limit(1);

      if (error) {
        if (mounted) setState({ user: null, loading: false, error: error.message });
        return;
      }
      const row = rows?.[0];
      if (!row) {
        // El user tiene auth.users pero NO tiene fila en comanda_usuarios.
        // Esto pasa cuando: (a) tiene cuenta PASE pero no se le asignó COMANDA,
        // (b) el comanda_usuario está desactivado.
        if (mounted) setState({
          user: null,
          loading: false,
          error: 'Este usuario no tiene acceso a COMANDA. Pedile al dueño que te lo habilite desde PASE → Herramientas → Usuarios COMANDA.',
        });
        return;
      }

      // ─── Cargar permisos comanda.* del user ───────────────────────────
      const { data: permsRes } = await db
        .from('comanda_usuario_permisos')
        .select('modulo_slug')
        .eq('comanda_usuario_id', row.id as string);

      const permisos = (permsRes ?? []).map((p) => p.modulo_slug as string);

      const rolPos = row.rol_pos as RolPos;
      const user: Usuario = {
        id: row.id as string,
        auth_id: row.auth_id as string,
        email: row.email as string,
        nombre: row.nombre as string,
        rol_pos: rolPos,
        rol: rolPos, // compat alias
        activo: row.activo as boolean,
        tenant_id: row.tenant_id as string | null,
        permisos,
        locales: (row.locales as number[] | null) ?? null,
        pin_pos: (row.pin_pos as string | null) ?? null,
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
