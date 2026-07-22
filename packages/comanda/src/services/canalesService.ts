import { db } from '../lib/supabase';
import type { Canal, ModoVenta } from '../types/database';
import { translateError } from '../lib/errors';
import { cacheGet, cacheSet, isNetworkError } from '../lib/offlineCache';

export async function listCanales(tenantId: string | null, soloActivos = false): Promise<{ data: Canal[]; error: string | null }> {
  const cacheKey = `canales:${tenantId ?? 'all'}:${soloActivos ? 'activos' : 'todos'}`;
  let q = db
    .from('canales')
    .select('*')
    .is('deleted_at', null)
    .order('grupo', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });
  if (tenantId) q = q.eq('tenant_id', tenantId);
  if (soloActivos) q = q.eq('activo', true);
  try {
    const { data, error } = await q;
    if (error) {
      if (isNetworkError(error)) {
        const offline = await cacheGet<Canal[]>('canales', cacheKey);
        if (offline) return { data: offline, error: null };
      }
      return { data: [], error: translateError(error) };
    }
    const result = data ?? [];
    void cacheSet('canales', cacheKey, result);
    return { data: result, error: null };
  } catch (err) {
    if (isNetworkError(err)) {
      const offline = await cacheGet<Canal[]>('canales', cacheKey);
      if (offline) return { data: offline, error: null };
    }
    throw err;
  }
}

/**
 * Resuelve el canal correcto para abrir una venta en un `modo` dado.
 *
 * Blinda el bug de 2026-07-21: SalonView/MostradorView resolvían el canal con
 * `listCanales(null)` (sin tenant) + `.find(c => c.slug === ...)`. En sesión
 * SUPERADMIN la RLS de `canales` devuelve canales de TODOS los tenants, así que
 * el `.find` podía agarrar un canal ajeno o incoherente → venta con canal malo
 * → precio/menú equivocados.
 *
 * Reglas:
 * - Scopea SIEMPRE por tenant (si `tenantId` es null devuelve null: preferimos
 *   fallar visible antes que adivinar un canal de otro tenant).
 * - Matchea por `modo_pos === modo` (dominio compartido salon|mostrador|pedidos).
 * - Prefiere el canal específico del local sobre el global (`local_id IS NULL`).
 * - Entre varios del mismo modo, prefiere el `preferSlug` canónico (p.ej. 'salon').
 *
 * Devuelve el canal elegido o null si no hay ninguno válido.
 */
export async function resolveCanalPorModo(
  tenantId: string | null,
  modo: ModoVenta,
  localId: number | null,
  preferSlug?: string,
): Promise<Canal | null> {
  if (!tenantId) return null;
  const { data } = await listCanales(tenantId, true);
  const candidatos = data.filter(
    (c) => c.modo_pos === modo && (c.local_id === localId || c.local_id === null),
  );
  if (candidatos.length === 0) return null;
  const score = (c: Canal) =>
    (localId !== null && c.local_id === localId ? 2 : 0) +
    (preferSlug && c.slug === preferSlug ? 1 : 0);
  return [...candidatos].sort((a, b) => score(b) - score(a))[0] ?? null;
}

export type CanalDraft = Pick<
  Canal,
  | 'nombre' | 'slug' | 'emoji' | 'color' | 'modo_pos' | 'atado_madre'
  | 'ajuste_madre_pct' | 'comision_externa_pct' | 'redondeo_a' | 'activo' | 'grupo'
> & { tenant_id: string; local_id: number | null };

export async function createCanal(draft: CanalDraft): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('canales').insert(draft).select('id').single();
  if (error) return { id: null, error: translateError(error) };
  return { id: data.id as number, error: null };
}

export async function updateCanal(id: number, patch: Partial<CanalDraft>): Promise<{ error: string | null }> {
  const { error } = await db.from('canales').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}

export async function toggleCanalActivo(id: number, activo: boolean): Promise<{ error: string | null }> {
  const { error } = await db.from('canales').update({ activo }).eq('id', id);
  return { error: error?.message ?? null };
}
