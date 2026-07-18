// Hook para chequear permisos en UI.
//
// Estrategia:
// 1. Si hay sesión Supabase con permisos hidratados (useAuth → user.permisos),
//    usar eso. Es la fuente de verdad cuando el usuario es dueño/admin en PASE
//    y maneja Settings.
// 2. Si NO hay sesión Supabase pero SÍ hay empleado POS activo (PIN),
//    derivar de rol_pos consultando la tabla `rol_pos_permisos`.
//
// F1.3 (2026-05-15): el mapping rol_pos → slugs vive en la tabla
// `rol_pos_permisos`. Se cachea en sessionStorage por rol_pos (TTL 1h).
// Reemplazó al objeto literal hardcoded. Mismo patrón que useCategorias y
// useMediosCobro.
//
// Convención: 'comanda.X.ver' (lectura) ⊂ 'comanda.X.editar/gestionar'
// (escritura). Si tenés escritura siempre tenés lectura.

import { useEffect, useState } from 'react';
import { useAuth } from './auth';
import { useAuthPos } from './authPos';
import { tienePermiso as userTienePermiso } from './auth';
import { db } from './supabase';
import type { RolPos } from '../types/database';

// Cache compartido entre todos los usos del hook. Se invalida al cerrar
// sesión POS (vaciado de sessionStorage por AuthPosProvider).
const CACHE_KEY_PREFIX = 'rol_pos_permisos_';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

interface CachedPermisos {
  slugs: string[];
  fetched_at: number;
}

function readCache(rolPos: RolPos): string[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY_PREFIX + rolPos);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPermisos;
    if (Date.now() - parsed.fetched_at > CACHE_TTL_MS) return null;
    return parsed.slugs;
  } catch { return null; }
}

function writeCache(rolPos: RolPos, slugs: string[]) {
  try {
    sessionStorage.setItem(CACHE_KEY_PREFIX + rolPos, JSON.stringify({
      slugs, fetched_at: Date.now(),
    } satisfies CachedPermisos));
  } catch { /* sessionStorage puede fallar — no crítico */ }
}

// Hook interno: devuelve los slugs concedidos al rol_pos del empleado POS.
// Se monta una vez por componente. Cache compartido via sessionStorage para
// que renders subsiguientes hidraten inmediato.
function usePermisosRolPos(rolPos: RolPos | null): string[] | null {
  const [slugs, setSlugs] = useState<string[] | null>(() =>
    rolPos ? readCache(rolPos) : null
  );

  useEffect(() => {
    if (!rolPos) {
      setSlugs(null);
      return;
    }
    const cached = readCache(rolPos);
    if (cached) {
      setSlugs(cached);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await db
        .from('rol_pos_permisos')
        .select('slug')
        .eq('rol_pos', rolPos)
        .eq('activo', true);
      if (cancelled) return;
      if (error) {
        // Defensive fallback: si la query falla, asumimos sin permisos
        // (RLS denegará el resto). Logueamos pero no rompemos UI.
        console.warn('[usePermiso] fetch rol_pos_permisos falló:', error.message);
        setSlugs([]);
        return;
      }
      const list = (data ?? []).map((r: { slug: string }) => r.slug);
      writeCache(rolPos, list);
      setSlugs(list);
    })();
    return () => { cancelled = true; };
  }, [rolPos]);

  return slugs;
}

export function usePermiso(slug: string): boolean {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const slugsRolPos = usePermisosRolPos(empleado?.rol_pos ?? null);

  // Convención: EDITAR incluye IMPORTAR el menú maestro (quien edita, importa).
  // Así, dar acceso a la sección con "importar" no le saca acceso a quien tenga
  // solo "editar".
  const slugsAceptados = slug === 'comanda.catalogo.maestro.importar'
    ? [slug, 'comanda.catalogo.maestro.editar']
    : [slug];

  // 1. Sesión Supabase con permisos hidratados (superadmin/dueño/admin
  // pasan por bypass; encargados llevan el array de slugs en user.permisos).
  if (user && slugsAceptados.some((s) => userTienePermiso(user, s))) return true;

  // 2. Sesión POS con empleado autenticado: derivar del rol_pos.
  if (empleado?.rol_pos && slugsRolPos) {
    if (slugsRolPos.includes('*') || slugsAceptados.some((s) => slugsRolPos.includes(s))) return true;
  }

  return false;
}
