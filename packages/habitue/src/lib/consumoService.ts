// consumoService — "qué come/pide" un comensal. Best-effort: matchea los
// pedidos de COMANDA (ventas_pos) por TELÉFONO (no hay cliente_id en ventas_pos)
// y agrega los items más pedidos. Si el teléfono está guardado distinto, puede
// no matchear — degrada elegante (muestra lo que encuentra).

import { db } from './supabase';

export interface ConsumoCliente {
  pedidos: number;
  total: number;
  topItems: { nombre: string; cantidad: number }[];
  ultimos: { fecha: string; total: number }[];
}

export async function getConsumoCliente(telefono: string | null): Promise<{ data: ConsumoCliente; error: string | null }> {
  const vacio: ConsumoCliente = { pedidos: 0, total: 0, topItems: [], ultimos: [] };
  if (!telefono) return { data: vacio, error: null };

  // 1) Pedidos cobrados de este teléfono.
  const { data: ventas, error: e1 } = await db()
    .from('ventas_pos')
    .select('id, total, cobrada_at')
    .eq('cliente_telefono', telefono)
    .not('cobrada_at', 'is', null)
    .is('deleted_at', null)
    .order('cobrada_at', { ascending: false })
    .limit(100);
  if (e1) return { data: vacio, error: e1.message };
  if (!ventas || ventas.length === 0) return { data: vacio, error: null };

  const ids = ventas.map((v) => v.id as number);
  const total = ventas.reduce((s, v) => s + Number(v.total ?? 0), 0);
  const ultimos = ventas.slice(0, 5).map((v) => ({ fecha: v.cobrada_at as string, total: Number(v.total ?? 0) }));

  // 2) Items de esos pedidos.
  const { data: items } = await db()
    .from('ventas_pos_items')
    .select('item_id, cantidad')
    .in('venta_id', ids)
    .limit(2000);

  const porItem = new Map<number, number>();
  for (const it of items ?? []) {
    const id = Number((it as { item_id: number }).item_id);
    const cant = Number((it as { cantidad: number }).cantidad ?? 1);
    if (!id) continue;
    porItem.set(id, (porItem.get(id) ?? 0) + cant);
  }

  // 3) Nombres del catálogo.
  let topItems: { nombre: string; cantidad: number }[] = [];
  if (porItem.size > 0) {
    const { data: cat } = await db().from('items').select('id, nombre').in('id', Array.from(porItem.keys()));
    const nombreById = new Map((cat ?? []).map((c) => [Number((c as { id: number }).id), (c as { nombre: string }).nombre]));
    topItems = Array.from(porItem.entries())
      .map(([id, cantidad]) => ({ nombre: nombreById.get(id) ?? `Item #${id}`, cantidad }))
      .sort((a, b) => b.cantidad - a.cantidad)
      .slice(0, 6);
  }

  return { data: { pedidos: ventas.length, total, topItems, ultimos }, error: null };
}
