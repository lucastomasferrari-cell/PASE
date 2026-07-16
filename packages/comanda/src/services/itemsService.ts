import { db } from '../lib/supabase';
import type { Item, ItemEstado } from '../types/database';
import { translateError } from '../lib/errors';
import { cacheGet, cacheSet, isNetworkError } from '../lib/offlineCache';

// Cache sessionStorage del catálogo (sprint optim egress 2026-05-16).
// TTL corto (60s) para no servir data muy stale, pero suficiente para que
// al navegar entre pantallas del admin (Items → Grupos → Items) NO refetche.
// Se invalida explícito desde createItem/updateItem/softDeleteItem.
const ITEMS_CACHE_KEY = 'comanda-items-cache';
const ITEMS_CACHE_TTL_MS = 60_000;
interface CacheEntry { data: ItemConGrupo[]; cachedAt: number; key: string }

function cacheKey(f: ItemsListFilter): string {
  return JSON.stringify([f.tenantId, f.localId, f.marcaId ?? null, f.maestro ?? false, f.grupoId, f.estado, f.search]);
}
function readCache(key: string): ItemConGrupo[] | null {
  try {
    const raw = sessionStorage.getItem(ITEMS_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CacheEntry;
    if (c.key !== key) return null;
    if (Date.now() - c.cachedAt > ITEMS_CACHE_TTL_MS) return null;
    return c.data;
  } catch { return null; }
}
function writeCache(key: string, data: ItemConGrupo[]): void {
  try {
    sessionStorage.setItem(ITEMS_CACHE_KEY, JSON.stringify({ data, cachedAt: Date.now(), key } satisfies CacheEntry));
  } catch { /* storage lleno, ignorar */ }
}
function clearItemsCache(): void {
  try { sessionStorage.removeItem(ITEMS_CACHE_KEY); } catch { /* ignore */ }
}

export type ItemConGrupo = Item & {
  grupo: { id: number; nombre: string; emoji: string | null; color: string | null } | null;
};

export interface ItemsListFilter {
  search?: string;
  grupoId?: number | null;
  estado?: ItemEstado | 'todos';
  localId?: number | null;
  /** Marca activa (del local). Trae items de esa marca + los compartidos
   * (marca_id NULL). Si es null/undefined no filtra por marca (compat). */
  marcaId?: number | null;
  /** true = MENÚ MAESTRO de la marca (items sin sucursal, local_id NULL).
   * Se usa en el editor de maestro. Ver fn_importar_menu_marca. */
  maestro?: boolean;
  tenantId: string | null;
}

// Importa el MENÚ MAESTRO de la marca a una sucursal (copia con local_id=local).
// modo 'reemplazar' (soft-delete lo actual + copia todo) o 'novedades' (agrega
// lo que falta). Backend: fn_importar_menu_marca (migración 202607160100).
export async function importarMenuMarca(
  localId: number, modo: 'reemplazar' | 'novedades' = 'reemplazar',
): Promise<{ data: { items: number; grupos: number } | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_importar_menu_marca', { p_local_id: localId, p_modo: modo });
  if (error) return { data: null, error: translateError(error) };
  clearItemsCache();
  return { data: data as { items: number; grupos: number }, error: null };
}

export async function listItems(filter: ItemsListFilter): Promise<{ data: ItemConGrupo[]; error: string | null }> {
  // Cache check primero (sprint optim egress 2026-05-16)
  const key = cacheKey(filter);
  const cached = readCache(key);
  if (cached) return { data: cached, error: null };

  // Sprint optimización egress 2026-05-16:
  // - Limit bajado de 500 a 200 (cubre 99% restaurants, más rápido)
  // - Sacadas columnas de auditoría no usadas en UI (created_by, updated_by,
  //   agotado_por, costo_actualizado_at, receta_version_id_vigente)
  // - Agregada tiempo_prep_min (la usa VentaScreen)
  let q = db
    .from('items')
    .select(`
      id, tenant_id, local_id, created_at, updated_at, deleted_at,
      nombre, descripcion, emoji, foto_url, codigo,
      grupo_id, orden, precio_madre, costo_actual,
      tax_rate_id, estacion, estado,
      agotado_motivo, agotado_at, agotado_hasta, es_combo,
      tiempo_prep_min,
      visible_pos, visible_qr, visible_tienda, es_open_item, es_cubierto, modos_pos_visibles,
      grupo:item_grupos(id, nombre, emoji, color)
    `)
    .is('deleted_at', null)
    .order('orden', { ascending: true })
    .order('id', { ascending: true })
    .limit(200);

  if (filter.tenantId) q = q.eq('tenant_id', filter.tenantId);
  if (filter.maestro) {
    // Menú MAESTRO de la marca: items sin sucursal (local_id NULL).
    q = q.is('local_id', null);
    if (filter.marcaId != null) q = q.eq('marca_id', filter.marcaId);
  } else if (filter.localId != null) {
    // Menú de la SUCURSAL: sus propias copias (local_id = la sucursal). Es el
    // modelo maestro+import: cada local ve solo lo que importó/creó.
    q = q.eq('local_id', filter.localId);
  } else if (filter.marcaId != null) {
    // Compat (sin local): items de la marca + compartidos (marca_id NULL).
    q = q.or(`marca_id.eq.${filter.marcaId},marca_id.is.null`);
  }
  if (filter.grupoId) q = q.eq('grupo_id', filter.grupoId);
  if (filter.estado && filter.estado !== 'todos') q = q.eq('estado', filter.estado);
  if (filter.search && filter.search.trim()) {
    q = q.ilike('nombre', `%${filter.search.trim()}%`);
  }

  try {
    const { data, error } = await q;
    if (error) {
      // Si es error de red, intentar fallback offline (IndexedDB).
      if (isNetworkError(error)) {
        const offline = await cacheGet<ItemConGrupo[]>('items', key);
        if (offline) return { data: offline, error: null };
      }
      return { data: [], error: translateError(error) };
    }
    const result = (data ?? []) as unknown as ItemConGrupo[];
    writeCache(key, result);
    // Persistir también en IndexedDB para uso offline cross-sesión.
    void cacheSet('items', key, result);
    return { data: result, error: null };
  } catch (err) {
    if (isNetworkError(err)) {
      const offline = await cacheGet<ItemConGrupo[]>('items', key);
      if (offline) return { data: offline, error: null };
    }
    throw err;
  }
}

export type ItemDraft = Pick<
  Item,
  'nombre' | 'descripcion' | 'emoji' | 'codigo' | 'grupo_id' | 'precio_madre' |
  'tax_rate_id' | 'estacion' | 'visible_pos' | 'visible_qr' | 'visible_tienda' | 'es_combo'
> & {
  tenant_id: string;
  local_id: number | null;
  /** Marca a la que pertenece el item. null = compartido entre marcas. */
  marca_id?: number | null;
  tiempo_prep_min?: number | null;
  // SKU externos para sync con partners. null si no integra con ese partner.
  sku_rappi?: string | null;
  sku_pedidosya?: string | null;
  sku_deliverect?: string | null;
};

export async function createItem(draft: ItemDraft): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.from('items').insert(draft).select('id').single();
  if (error) return { id: null, error: translateError(error) };
  clearItemsCache();
  return { id: data.id as number, error: null };
}

export async function updateItem(
  id: number,
  patch: Partial<ItemDraft>,
): Promise<{ error: string | null }> {
  const { error } = await db.from('items').update(patch).eq('id', id);
  if (!error) clearItemsCache();
  return { error: error?.message ?? null };
}

export async function softDeleteItem(id: number): Promise<{ error: string | null }> {
  const { error } = await db.from('items').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (!error) clearItemsCache();
  return { error: error?.message ?? null };
}

export async function marcarAgotado(
  itemId: number,
  motivo: string,
  hasta: string | null,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_marcar_agotado_comanda', {
    p_item_id: itemId,
    p_motivo: motivo,
    p_hasta: hasta,
  });
  if (!error) clearItemsCache();
  return { error: error?.message ?? null };
}

export async function marcarDisponible(itemId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_marcar_disponible_comanda', { p_item_id: itemId });
  if (!error) clearItemsCache();
  return { error: error?.message ?? null };
}
