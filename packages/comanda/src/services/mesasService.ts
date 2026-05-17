import { db } from '../lib/supabase';
import type { Mesa, EstadoMesa, FormaMesa } from '../types/database';
import { translateError } from '../lib/errors';
import { cacheGet, cacheSet, isNetworkError } from '../lib/offlineCache';

export async function listMesas(localId: number): Promise<{ data: Mesa[]; error: string | null }> {
  const { data, error } = await db
    .from('mesas')
    .select('*')
    .eq('local_id', localId)
    .is('deleted_at', null)
    .order('zona', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as Mesa[], error: null };
}

// Mesa con info adicional para el grid (venta abierta + total + tiempo)
export interface MesaConVenta extends Mesa {
  venta_abierta_id: number | null;
  venta_total: number;
  venta_abierta_at: string | null;
}

export async function listMesasConVentas(localId: number): Promise<{ data: MesaConVenta[]; error: string | null }> {
  const cacheKey = `mesas:${localId}`;
  try {
    // 2 queries en paralelo: mesas + ventas abiertas del local
    const [mesasRes, ventasRes] = await Promise.all([
      db.from('mesas').select('*').eq('local_id', localId).is('deleted_at', null)
        .order('zona', { ascending: true, nullsFirst: false }).order('id', { ascending: true }),
      db.from('ventas_pos').select('id, mesa_id, total, abierta_at, estado')
        .eq('local_id', localId).in('estado', ['abierta', 'enviada', 'lista', 'entregada'])
        .is('deleted_at', null),
    ]);
    if (mesasRes.error || ventasRes.error) {
      const err = mesasRes.error ?? ventasRes.error;
      if (err && isNetworkError(err)) {
        const offline = await cacheGet<MesaConVenta[]>('mesas', cacheKey);
        if (offline) return { data: offline, error: null };
      }
      return { data: [], error: (err?.message ?? 'Error desconocido') };
    }
    const ventasByMesa = new Map<number, { id: number; total: number; abierta_at: string }>();
    for (const v of ventasRes.data ?? []) {
      if (v.mesa_id !== null && v.mesa_id !== undefined) {
        ventasByMesa.set(v.mesa_id as number, {
          id: v.id as number,
          total: Number(v.total ?? 0),
          abierta_at: v.abierta_at as string,
        });
      }
    }
    const data: MesaConVenta[] = (mesasRes.data ?? []).map((m) => {
      const v = ventasByMesa.get(m.id as number);
      return {
        ...(m as Mesa),
        venta_abierta_id: v?.id ?? null,
        venta_total: v?.total ?? 0,
        venta_abierta_at: v?.abierta_at ?? null,
      };
    });
    // Cache para uso offline. NOTA: las mesas offline pueden estar stale
    // (no sabemos qué pasó mientras estuvimos sin conexión). El banner
    // visible avisa al usuario que NO confíe del estado actual.
    void cacheSet('mesas', cacheKey, data);
    return { data, error: null };
  } catch (err) {
    if (isNetworkError(err)) {
      const offline = await cacheGet<MesaConVenta[]>('mesas', cacheKey);
      if (offline) return { data: offline, error: null };
    }
    throw err;
  }
}

export interface MesaDraft {
  numero: string;
  zona: string | null;
  capacidad: number | null;
  forma: FormaMesa;
  tenant_id: string;
  local_id: number;
}

export async function createMesa(draft: MesaDraft): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('mesas').insert(draft).select('id').single();
  if (error) return { id: null, error: translateError(error) };
  return { id: data.id as number, error: null };
}

export async function updateMesa(id: number, patch: Partial<MesaDraft>): Promise<{ error: string | null }> {
  const { error } = await db.from('mesas').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}

export async function setMesaEstado(id: number, estado: EstadoMesa): Promise<{ error: string | null }> {
  const { error } = await db.from('mesas').update({ estado }).eq('id', id);
  return { error: error?.message ?? null };
}

export async function updateMesaPosicion(id: number, x: number, y: number): Promise<{ error: string | null }> {
  const { error } = await db.from('mesas').update({ pos_x: Math.round(x), pos_y: Math.round(y) }).eq('id', id);
  return { error: error?.message ?? null };
}

export async function softDeleteMesa(id: number): Promise<{ error: string | null }> {
  // Validar no tiene ventas históricas
  const { count } = await db.from('ventas_pos')
    .select('id', { count: 'exact', head: true }).eq('mesa_id', id);
  if ((count ?? 0) > 0) return { error: 'No se puede borrar: la mesa tiene ventas asociadas.' };
  const { error } = await db.from('mesas').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}

// ─── Operaciones de mesa con override (Sprint 4) ──────────────────────────

export async function transferirMesaService(
  ventaId: number,
  mesaDestinoId: number,
  managerId: string,
  motivo: string,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_transferir_mesa_comanda', {
    p_venta_id: ventaId,
    p_mesa_destino: mesaDestinoId,
    p_manager_id: managerId,
    p_motivo: motivo,
  });
  return { error: error?.message ?? null };
}

export async function unirMesasService(
  ventaOrigenId: number,
  ventaDestinoId: number,
  managerId: string,
  motivo: string,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_unir_mesas_comanda', {
    p_venta_origen_id: ventaOrigenId,
    p_venta_destino_id: ventaDestinoId,
    p_manager_id: managerId,
    p_motivo: motivo,
  });
  return { error: error?.message ?? null };
}

export async function partirCuentaService(
  ventaId: number,
  itemIds: number[],
  managerId: string,
  motivo: string,
): Promise<{ ventaNuevaId: number | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_partir_cuenta_comanda', {
    p_venta_id: ventaId,
    p_item_ids: itemIds,
    p_manager_id: managerId,
    p_motivo: motivo,
  });
  if (error) return { ventaNuevaId: null, error: translateError(error) };
  return { ventaNuevaId: data as number, error: null };
}

// Mesas libres del local (para selectores en Transfer/Merge dialogs)
export async function listMesasLibres(localId: number): Promise<{ data: Array<{ id: number; numero: string; zona: string | null }>; error: string | null }> {
  const { data, error } = await db
    .from('mesas')
    .select('id, numero, zona')
    .eq('local_id', localId)
    .eq('estado', 'libre')
    .is('deleted_at', null)
    .order('numero', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as Array<{ id: number; numero: string; zona: string | null }>, error: null };
}
