// Auth del Admin Console.
//
// Solo usuarios con `usuarios.rol = 'superadmin'` pueden operar acá.
// La función SQL `auth_es_superadmin()` (definida en migration
// 202604281200_tenants_foundation.sql) es el chequeo server-side oficial y
// se invoca en cada RLS de las RPCs/tablas que toca el Admin Console. Acá
// hacemos un mirror client-side para gatear la UI.

import { useEffect, useState } from 'react';
import { db } from './supabase';
import type { Session } from '@supabase/supabase-js';

export interface AdminUser {
  id: number;          // usuarios.id (integer, no UUID — legado pre-multi-tenant)
  email: string;
  nombre: string | null;
  rol: 'superadmin';
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'forbidden'; reason: string }   // logueado pero no es superadmin
  | { status: 'authenticated'; user: AdminUser };

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function loadFromSession(session: Session | null) {
      if (!session?.user) {
        if (!cancelled) setState({ status: 'unauthenticated' });
        return;
      }
      // Bajamos rol del usuario desde la tabla usuarios. El FK a Supabase Auth
      // es `auth_id` (UUID), no `auth_user_id`.
      const { data, error } = await db
        .from('usuarios')
        .select('id, email, nombre, rol, activo')
        .eq('auth_id', session.user.id)
        .single();
      if (cancelled) return;
      if (error || !data) {
        setState({
          status: 'forbidden',
          reason: 'No encontramos tu perfil en la tabla usuarios. Pedile al dueño que te dé de alta.',
        });
        return;
      }
      if (!data.activo) {
        setState({
          status: 'forbidden',
          reason: 'Tu usuario está marcado como inactivo.',
        });
        return;
      }
      if (data.rol !== 'superadmin') {
        setState({
          status: 'forbidden',
          reason: `Tu rol actual ("${data.rol}") no tiene acceso al Admin Console. Solo el rol "superadmin" lo opera.`,
        });
        return;
      }
      setState({
        status: 'authenticated',
        user: {
          id: data.id,
          email: data.email,
          nombre: data.nombre,
          rol: 'superadmin',
        },
      });
    }

    // Sesión actual (si ya estaba logueado).
    void db.auth.getSession().then(({ data }) => loadFromSession(data.session));

    // Suscribirse a cambios (login/logout/refresh).
    const { data: sub } = db.auth.onAuthStateChange((_event, session) => {
      void loadFromSession(session);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}

export async function signIn(email: string, password: string): Promise<{ error: string | null }> {
  // El email en `usuarios.email` puede ser sin `@`. En PASE el wrapper
  // concatena `@pase.local` si no contiene `@`. Replicamos.
  const emailFull = email.includes('@') ? email : `${email}@pase.local`;
  const { error } = await db.auth.signInWithPassword({ email: emailFull, password });
  return { error: error?.message ?? null };
}

export async function signOut(): Promise<void> {
  await db.auth.signOut();
}
