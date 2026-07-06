import { db } from '../lib/supabase';
import type { VentaPos, EstadoVenta, VentaPosItem, VentaPosPago, Canal } from '../types/database';
import { translateError } from '../lib/errors';

// Mapeo lógico de tab → estado de venta para el feed Pedidos.
// Taxonomía nueva (2026-07-05): 4 estados operativos + "Todos".
//  - por_aceptar → necesita_aprobacion (esperando ok del comerciante).
//  - programadas → cualquier pedido con programada_para futura.
//  - aceptadas   → abierta / enviada / lista / en_camino (todo el ciclo activo).
//  - cerradas    → entregada / cobrada.
// Anuladas se excluyen por default en todas las tabs (se veran en un filtro
// aparte cuando exista).
export type PedidoTab = 'todos' | 'por_aceptar' | 'programadas' | 'aceptadas' | 'cerradas';

const ESTADOS_ACEPTADAS: EstadoVenta[] = ['abierta', 'enviada', 'lista', 'en_camino'];
const ESTADOS_CERRADAS: EstadoVenta[] = ['entregada', 'cobrada'];
// Estados que "Todos" considera visibles (todo menos anulada).
const ESTADOS_VISIBLES: EstadoVenta[] = [
  'abierta', 'necesita_aprobacion', 'programada',
  'enviada', 'lista', 'en_camino',
  'entregada', 'cobrada',
];

// Grupo lógico de un pedido → drive del color/tag en la card y del orden en "Todos".
export type PedidoGrupo = 'por_aceptar' | 'programadas' | 'aceptadas' | 'cerradas';

export function grupoDePedido(estado: EstadoVenta, programadaPara: string | null): PedidoGrupo {
  const futuro = programadaPara && new Date(programadaPara).getTime() > Date.now();
  if (futuro) return 'programadas';
  if (estado === 'necesita_aprobacion') return 'por_aceptar';
  if (ESTADOS_ACEPTADAS.includes(estado)) return 'aceptadas';
  if (ESTADOS_CERRADAS.includes(estado)) return 'cerradas';
  // 'programada' con fecha pasada o nula: la tratamos como aceptada (ya
  // vencio la programacion, hay que operarla).
  return 'aceptadas';
}

const GRUPO_PRIORIDAD: Record<PedidoGrupo, number> = {
  por_aceptar: 1,
  programadas: 2,
  aceptadas: 3,
  cerradas: 4,
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
  const ahoraIso = new Date().toISOString();
  let q = db
    .from('ventas_pos')
    .select('*, items:ventas_pos_items(*, item:items(nombre, emoji))')
    .eq('local_id', localId)
    .eq('modo', 'pedidos')
    .is('deleted_at', null);

  if (tab === 'todos') {
    // Todo lo visible (no anuladas). Se ordena en cliente por grupo + created_at.
    q = q.in('estado', ESTADOS_VISIBLES).order('created_at', { ascending: false });
  } else if (tab === 'programadas') {
    // Cualquier pedido con programada_para futura, sin importar el estado
    // (salvo cerradas — si ya se cobró/entregó no está "programado").
    q = q.in('estado', [...ESTADOS_ACEPTADAS, 'necesita_aprobacion', 'programada'])
         .gt('programada_para', ahoraIso)
         .order('programada_para', { ascending: true });
  } else if (tab === 'por_aceptar') {
    // Sólo pedidos para AHORA (sin programada_para futura). Los que tienen
    // fecha futura viven en "Programadas" hasta que llega el momento.
    q = q.eq('estado', 'necesita_aprobacion')
         .or(`programada_para.is.null,programada_para.lte.${ahoraIso}`)
         .order('created_at', { ascending: false });
  } else if (tab === 'aceptadas') {
    // En ciclo activo Y no programada a futuro. Incluye 'abierta' (cajero
    // cargando items) — con esto ya no se pierden pedidos post-Nuevo.
    q = q.in('estado', ESTADOS_ACEPTADAS)
         .or(`programada_para.is.null,programada_para.lte.${ahoraIso}`)
         .order('created_at', { ascending: false });
  } else {
    // cerradas: sin filtro de programada_para (ya se resolvió).
    q = q.in('estado', ESTADOS_CERRADAS).order('created_at', { ascending: false });
  }

  const { data, error } = await q.limit(tab === 'todos' ? 200 : 100);
  if (error) return { data: [], error: translateError(error) };
  const cleaned = (data ?? []).map((row) => {
    const r = row as PedidoConItems;
    return { ...r, items: (r.items ?? []).filter((it) => it.deleted_at === null) };
  });
  // "Todos" reordena por grupo (por_aceptar → programadas → aceptadas →
  // cerradas) manteniendo created_at desc dentro de cada grupo. Los otros
  // tabs ya vienen ordenados por SQL.
  if (tab === 'todos') {
    cleaned.sort((a, b) => {
      const ga = GRUPO_PRIORIDAD[grupoDePedido(a.estado, a.programada_para)];
      const gb = GRUPO_PRIORIDAD[grupoDePedido(b.estado, b.programada_para)];
      if (ga !== gb) return ga - gb;
      return new Date(b.abierta_at).getTime() - new Date(a.abierta_at).getTime();
    });
  }
  return { data: cleaned, error: null };
}

// Counters por tab (para badges en navegación).
// "cerradas" no lleva contador (rutinariamente grande; no aporta info accionable).
// "todos" tampoco — su valor es el total activo, ya visible sumando los tres.
export async function getCountersPedidos(localId: number): Promise<Record<PedidoTab, number>> {
  const { data } = await db
    .from('ventas_pos')
    .select('estado, programada_para')
    .eq('local_id', localId)
    .eq('modo', 'pedidos')
    .is('deleted_at', null)
    .in('estado', [...ESTADOS_ACEPTADAS, 'necesita_aprobacion', 'programada']);
  const out: Record<PedidoTab, number> = {
    todos: 0, por_aceptar: 0, programadas: 0, aceptadas: 0, cerradas: 0,
  };
  for (const row of data ?? []) {
    const r = row as { estado: EstadoVenta; programada_para: string | null };
    const g = grupoDePedido(r.estado, r.programada_para);
    if (g === 'cerradas') continue;
    out[g]++;
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

// Marcha todo lo que quedó en 'hold' de una venta y pasa venta a 'enviada'.
// Idempotente. Se llama al apretar "Marchar" o "Listo" en la pantalla de carga.
export async function marcharTodoPedidoService(ventaId: number): Promise<{ marchados: number; error: string | null }> {
  const { data, error } = await db.rpc('fn_pedido_marchar_todo_comanda', { p_venta_id: ventaId });
  if (error) return { marchados: 0, error: error.message };
  return { marchados: Number(data ?? 0), error: null };
}

// Avanza el pedido directo a 'entregada' desde cualquier estado activo.
// Items en hold/enviado/listo pasan a 'entregado'. No cobra.
export async function finalizarPedidoService(ventaId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_pedido_finalizar_comanda', { p_venta_id: ventaId });
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
