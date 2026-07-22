import { db } from '../lib/supabase';
import type { ListaPrecio } from '../types/database';
import { translateError } from '../lib/errors';

// ─────────────────────────────────────────────────────────────────────────
// Listas de precios (Fase 3 config — 22-jul). Una "lista" con nombre propio
// que uno o varios canales pueden usar. Compartir = dos canales apuntando a
// la misma lista. Esta capa SOLO lee/escribe las tablas nuevas + el puntero
// canales.lista_precio_id. NO toca el cobro (eso es Fase 2).
// ─────────────────────────────────────────────────────────────────────────

export interface ListaPrecioConUso extends ListaPrecio {
  /** canales que usan esta lista */
  canalesUsando: Array<{ id: number; nombre: string; emoji: string | null }>;
  /** cantidad de precios cargados (items) en la lista */
  itemsCount: number;
}

export async function listListasPrecios(
  tenantId: string | null,
): Promise<{ data: ListaPrecioConUso[]; error: string | null }> {
  const [listasRes, canalesRes, itemsRes] = await Promise.all([
    (() => {
      let q = db.from('listas_precios').select('*').is('deleted_at', null).order('id', { ascending: true });
      if (tenantId) q = q.eq('tenant_id', tenantId);
      return q;
    })(),
    (() => {
      let q = db.from('canales').select('id, nombre, emoji, lista_precio_id').is('deleted_at', null);
      if (tenantId) q = q.eq('tenant_id', tenantId);
      return q;
    })(),
    (() => {
      let q = db.from('lista_precio_items').select('lista_precio_id').is('deleted_at', null);
      if (tenantId) q = q.eq('tenant_id', tenantId);
      return q;
    })(),
  ]);

  if (listasRes.error) return { data: [], error: translateError(listasRes.error) };
  if (canalesRes.error) return { data: [], error: translateError(canalesRes.error) };
  if (itemsRes.error) return { data: [], error: translateError(itemsRes.error) };

  const canalesPorLista = new Map<number, Array<{ id: number; nombre: string; emoji: string | null }>>();
  for (const c of canalesRes.data ?? []) {
    const lid = c.lista_precio_id as number | null;
    if (lid == null) continue;
    const arr = canalesPorLista.get(lid) ?? [];
    arr.push({ id: c.id as number, nombre: c.nombre as string, emoji: (c.emoji as string | null) ?? null });
    canalesPorLista.set(lid, arr);
  }

  const itemsPorLista = new Map<number, number>();
  for (const r of itemsRes.data ?? []) {
    const lid = r.lista_precio_id as number;
    itemsPorLista.set(lid, (itemsPorLista.get(lid) ?? 0) + 1);
  }

  const data = (listasRes.data ?? []).map((l) => ({
    ...(l as ListaPrecio),
    canalesUsando: canalesPorLista.get(l.id as number) ?? [],
    itemsCount: itemsPorLista.get(l.id as number) ?? 0,
  }));

  return { data, error: null };
}

export interface ListaPrecioDraft {
  nombre: string;
  atado_madre: boolean;
  ajuste_madre_pct: number;
  redondeo_a: number | null;
  activa: boolean;
}

export async function createListaPrecio(
  draft: ListaPrecioDraft,
  tenantId: string,
  localId: number | null,
): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db
    .from('listas_precios')
    .insert({ ...draft, tenant_id: tenantId, local_id: localId })
    .select('id')
    .single();
  if (error) return { id: null, error: translateError(error) };
  return { id: data.id as number, error: null };
}

export async function updateListaPrecio(
  id: number,
  patch: Partial<ListaPrecioDraft>,
): Promise<{ error: string | null }> {
  const { error } = await db.from('listas_precios').update(patch).eq('id', id);
  return { error: error ? translateError(error) : null };
}

// Asigna (o comparte) una lista a un canal. Escribe canales.lista_precio_id,
// campo que hoy ningún lector usa todavía → 100% seguro hasta la Fase 2.
export async function setCanalLista(
  canalId: number,
  listaId: number | null,
): Promise<{ error: string | null }> {
  const { error } = await db.from('canales').update({ lista_precio_id: listaId }).eq('id', canalId);
  return { error: error ? translateError(error) : null };
}
