import { db } from '../lib/supabase';
import type { VentaPos, EstadoVenta, VentaPosItem, VentaPosPago, Canal } from '../types/database';
import { translateError } from '../lib/errors';

// Mapeo lógico de "tab" a estado de venta para el feed Pedidos.
// Nota: 'activos' = enviada (en preparación). 'listos' = lista (esperando retiro/entrega).
// 'completados' = entregada/cobrada.
export type PedidoTab = 'necesita_aprobacion' | 'programados' | 'activos' | 'listos' | 'completados';

const TAB_TO_ESTADOS: Record<PedidoTab, EstadoVenta[]> = {
  necesita_aprobacion: ['necesita_aprobacion'],
  programados:         ['programada'],
  activos:             ['enviada'],
  listos:              ['lista'],
  completados:         ['entregada', 'cobrada'],
};

// Pedido enriquecido con items embebidos — usado para resumen en cards (mostrar 3 items + "y N más").
// PERF NOTE: items se traen con join Supabase en una sola query; típicamente <100 pedidos por tab,
// con avg 4 items por pedido = ~400 rows total — aceptable.
export interface PedidoConItems extends VentaPos {
  items: VentaPosItem[];
}

export async function listPedidosPorTab(
  localId: number,
  tab: PedidoTab,
): Promise<{ data: PedidoConItems[]; error: string | null }> {
  let q = db
    .from('ventas_pos')
    .select('*, items:ventas_pos_items(*, item:items(nombre, emoji))')
    .eq('local_id', localId)
    .eq('modo', 'pedidos')
    .is('deleted_at', null);

  // Tab "programados" (Lucas 2026-05-19): un pedido es "programado" si
  // tiene programada_para futuro Y todavía no fue entregado/cobrado.
  // Esto incluye los que están en 'necesita_aprobacion' con fecha futura
  // (caso típico del marketplace: cliente pidió para mañana, comerciante
  // todavía no aprobó).
  // El tab "necesita_aprobacion" excluye los programados — solo muestra
  // los que son para AHORA (sin programada_para o vencida).
  if (tab === 'programados') {
    q = q.in('estado', ['necesita_aprobacion', 'programada', 'enviada', 'lista'])
         .gt('programada_para', new Date().toISOString())
         .order('programada_para', { ascending: true });
  } else if (tab === 'necesita_aprobacion') {
    // Solo pedidos para AHORA (sin programada_para futura).
    q = q.eq('estado', 'necesita_aprobacion')
         .or(`programada_para.is.null,programada_para.lte.${new Date().toISOString()}`)
         .order('created_at', { ascending: false });
  } else {
    const estados = TAB_TO_ESTADOS[tab];
    q = q.in('estado', estados).order('created_at', { ascending: false });
  }

  const { data, error } = await q.limit(100);
  if (error) return { data: [], error: translateError(error) };
  const cleaned = (data ?? []).map((row) => {
    const r = row as PedidoConItems;
    return { ...r, items: (r.items ?? []).filter((it) => it.deleted_at === null) };
  });
  return { data: cleaned, error: null };
}

// Counters por tab (para badges en navegación).
export async function getCountersPedidos(localId: number): Promise<Record<PedidoTab, number>> {
  const { data } = await db
    .from('ventas_pos')
    .select('estado, programada_para')
    .eq('local_id', localId)
    .eq('modo', 'pedidos')
    .is('deleted_at', null)
    .in('estado', ['necesita_aprobacion', 'programada', 'enviada', 'lista']);
  const out: Record<PedidoTab, number> = {
    necesita_aprobacion: 0, programados: 0, activos: 0, listos: 0, completados: 0,
  };
  const ahora = Date.now();
  for (const row of data ?? []) {
    const r = row as { estado: EstadoVenta; programada_para: string | null };
    const esFuturo = r.programada_para && new Date(r.programada_para).getTime() > ahora;
    // Si tiene programada_para futuro, va al tab "programados" (sin importar estado).
    if (esFuturo) {
      out.programados++;
      continue;
    }
    // Sino, va al tab que corresponda a su estado.
    for (const [tab, estados] of Object.entries(TAB_TO_ESTADOS)) {
      if (tab === 'programados') continue;
      if (estados.includes(r.estado)) {
        out[tab as PedidoTab] = (out[tab as PedidoTab] ?? 0) + 1;
      }
    }
  }
  return out;
}

// Detalle completo de un pedido — usado por la vista detallada `/pos/pedidos/:ventaId`.
// Incluye items + pagos + canal en una sola query con joins de Supabase.
// Cada item trae además el nombre y emoji del item maestro via join a `items`.
export interface VentaPosItemConNombre extends VentaPosItem {
  item_nombre: string;
  item_emoji: string | null;
}

export interface PedidoDetalleData {
  venta: VentaPos;
  items: VentaPosItemConNombre[];
  pagos: VentaPosPago[];
  canal: Canal | null;
}

export async function getPedidoDetalle(
  ventaId: number,
): Promise<{ data: PedidoDetalleData | null; error: string | null }> {
  const { data, error } = await db
    .from('ventas_pos')
    .select(
      '*,' +
      ' items:ventas_pos_items(*, item:items(nombre, emoji)),' +
      ' pagos:ventas_pos_pagos(*),' +
      ' canal:canales(*)'
    )
    .eq('id', ventaId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return { data: null, error: translateError(error) };
  if (!data) return { data: null, error: 'PEDIDO_NO_ENCONTRADO' };
  type ItemRaw = VentaPosItem & { item: { nombre: string; emoji: string | null } | null };
  const r = data as unknown as VentaPos & { items: ItemRaw[]; pagos: VentaPosPago[]; canal: Canal | null };
  return {
    data: {
      venta: r,
      items: (r.items ?? [])
        .filter((it) => it.deleted_at === null)
        .map((it) => ({
          ...it,
          item_nombre: it.item?.nombre ?? `Item #${it.item_id}`,
          item_emoji: it.item?.emoji ?? null,
        })),
      pagos: (r.pagos ?? []).filter((p) => p.estado === 'confirmado'),
      canal: r.canal,
    },
    error: null,
  };
}

// Actualiza quote times de comanda_local_settings. Manager+ only (controlado por RLS).
export async function updateQuoteTimes(
  localId: number,
  tiempoRetiroMin: number,
  tiempoDeliveryMin: number,
): Promise<{ error: string | null }> {
  const { error } = await db
    .from('comanda_local_settings')
    .update({
      tiempo_retiro_min: tiempoRetiroMin,
      tiempo_delivery_min: tiempoDeliveryMin,
    })
    .eq('local_id', localId);
  return { error: error?.message ?? null };
}

export async function getQuoteTimes(
  localId: number,
): Promise<{ retiro: number; delivery: number } | null> {
  const { data } = await db
    .from('comanda_local_settings')
    .select('tiempo_retiro_min, tiempo_delivery_min')
    .eq('local_id', localId)
    .maybeSingle();
  if (!data) return null;
  const row = data as { tiempo_retiro_min: number; tiempo_delivery_min: number };
  return { retiro: row.tiempo_retiro_min, delivery: row.tiempo_delivery_min };
}

export async function aprobarPedidoService(ventaId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_aprobar_pedido_comanda', { p_venta_id: ventaId });
  if (error) return { error: error.message };
  // Gap impresoras Sprint 4: imprimir comanda de cocina al aprobar.
  // Fire-and-forget — el agent maneja queue + retries. Idempotente.
  void (async () => {
    try {
      const { imprimirCocinaSiCorresponde } = await import('./ventasService');
      await imprimirCocinaSiCorresponde(ventaId, 0);
    } catch (err) {
      console.warn('[aprobar] print kitchen falló:', err);
    }
  })();
  return { error: null };
}

export async function marcarListoService(ventaId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_marcar_listo_comanda', { p_venta_id: ventaId });
  return { error: error?.message ?? null };
}

export async function marcarEntregadoService(ventaId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_marcar_entregado_comanda', { p_venta_id: ventaId });
  return { error: error?.message ?? null };
}

// Cancelar pedido = anular venta. Requiere manager_id + motivo (PIN ya validado por
// ManagerOverrideDialog antes de invocar).
export async function cancelarPedidoService(
  ventaId: number,
  managerId: string,
  motivo: string,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_anular_venta_comanda', {
    p_venta_id: ventaId,
    p_manager_id: managerId,
    p_motivo: motivo,
  });
  return { error: error?.message ?? null };
}

// Helper: estado de pago derivado de la suma de pagos confirmados.
// 'pagado'    → existe ≥1 pago confirmado que cubre total.
// 'pendiente' → suma de pagos < total. Se complementa con tipo_entrega para el badge AR:
//                tipo_entrega='retiro'   → "PAGA EN LOCAL"
//                tipo_entrega='delivery' → "PAGA AL RETIRAR"
export type EstadoPagoDerivado = 'pagado' | 'pendiente';

export function calcularEstadoPago(
  total: number,
  pagosConfirmados: VentaPosPago[],
): EstadoPagoDerivado {
  const totalPagado = pagosConfirmados.reduce((s, p) => s + Number(p.monto), 0);
  return totalPagado >= total ? 'pagado' : 'pendiente';
}
