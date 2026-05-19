import { db } from '../lib/supabase';
import { translateError } from '../lib/errors';
import type {
  VentaPos, VentaPosItem, VentaPosItemModificador, ModoVenta, EstadoVenta,
  TipoEntrega, OrigenVenta,
} from '../types/database';

// Helper interno: si la venta tiene external_provider + external_order_id,
// dispara fire-and-forget al endpoint que notifica al partner de un cambio
// de estado. No bloqueamos el flow del POS si falla — el dueño puede
// reintentar manualmente desde la UI de pedidos externos.
//
// Action es genérica ('accept' / 'dispatch' / 'cancel') — el wrapper la
// traduce al verbo específico del partner:
//   Rappi: take / dispatch / cancel
//   PedidosYa: accept / dispatch / cancel
async function notifyPartnerStatusChange(
  ventaId: number,
  action: 'accept' | 'dispatch' | 'cancel',
  opts: { prepTimeMinutes?: number; reason?: string } = {},
): Promise<void> {
  try {
    const { data: venta } = await db.from('ventas_pos')
      .select('external_provider, external_order_id')
      .eq('id', ventaId)
      .single();
    if (!venta?.external_provider || !venta.external_order_id) return;

    const sess = (await db.auth.getSession()).data.session;
    if (!sess?.access_token) return;

    // Wireup por provider
    let endpointAction: string;
    let providerAction: string;
    if (venta.external_provider === 'rappi') {
      endpointAction = 'rappi-order-action';
      providerAction = action === 'accept' ? 'take' : action;
    } else if (venta.external_provider === 'pedidos-ya') {
      endpointAction = 'pedidosya-order-action';
      providerAction = action; // PeYa usa accept/dispatch/cancel directamente
    } else {
      return; // Deliverect u otros — sin wire todavía
    }

    void fetch(`/api/tienda-mp?action=${endpointAction}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sess.access_token}`,
      },
      body: JSON.stringify({
        order_id: venta.external_order_id,
        action: providerAction,
        prep_time_minutes: opts.prepTimeMinutes,
        reason: opts.reason,
        production: false, // por default staging hasta que el dueño esté listo
      }),
    }).catch(() => { /* silent fire-and-forget */ });
  } catch {
    /* silent — no rompemos POS si el lookup falla */
  }
}

export interface AbrirVentaArgs {
  localId: number;
  modo: ModoVenta;
  canalId: number;
  mesaId?: number | null;
  mozoId?: string | null;
  cajeroId?: string | null;
  clienteNombre?: string | null;
  clienteTelefono?: string | null;
  clienteDireccion?: string | null;
  covers?: number | null;
  origen?: OrigenVenta;
  tipoEntrega?: TipoEntrega | null;
  estado?: EstadoVenta;
  /** ISO timestamp. Si se setea, el pedido es para horario futuro. */
  programadaPara?: string | null;
  /** ID del cliente del CRM (clientes.id). Activa trigger de contadores al cobrar. */
  clienteId?: number | null;
}

export async function abrirVenta(args: AbrirVentaArgs): Promise<{ ventaId: number | null; error: string | null }> {
  // Fase 4.3 — feature flag offline-first. Cuando está activo, escribe local
  // primero + encola para sync. Devuelve un tempId negativo que la UI puede
  // usar para navegar; cuando el sync confirma, el repo local actualiza el id
  // y emite evento `comanda:reconcile-id` para que la UI navegue al real.
  const { featureFlags } = await import('../lib/featureFlags');
  if (featureFlags.offlineFirstVentas) {
    const { abrirVentaOffline } = await import('./offline/ventasOfflineService');
    // tenantId requiere viaje porque la RPC offline lo deriva del auth de la
    // sesión. Acá lo pasamos vacío y el service local lo guarda en la fila
    // (servirá cuando el sync resuelva el server-side).
    // tenantId NO está en AbrirVentaArgs original — lo derivamos del modo
    // sync (auth_tenant_id() server). Por ahora pasamos string vacío y el
    // repo guarda el row; el server al sync usa auth_tenant_id().
    try {
      const r = await abrirVentaOffline({
        tenantId: '',
        localId: args.localId,
        canalId: args.canalId,
        modo: args.modo as 'salon' | 'mostrador' | 'delivery' | 'retiro',
        mesaId: args.mesaId ?? null,
        mozoId: args.mozoId ?? null,
        cajeroId: args.cajeroId ?? null,
        clienteId: args.clienteId ?? null,
        covers: args.covers ?? 2,
      });
      return { ventaId: r.tempVentaId, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error abriendo venta offline';
      return { ventaId: null, error: msg };
    }
  }

  // Flujo legacy online-only (default mientras el flag esté off)
  const { data, error } = await db.rpc('fn_abrir_venta_comanda', {
    p_local_id: args.localId,
    p_modo: args.modo,
    p_canal_id: args.canalId,
    p_mesa_id: args.mesaId ?? null,
    p_mozo_id: args.mozoId ?? null,
    p_cajero_id: args.cajeroId ?? null,
    p_cliente_nombre: args.clienteNombre ?? null,
    p_cliente_telefono: args.clienteTelefono ?? null,
    p_cliente_direccion: args.clienteDireccion ?? null,
    p_covers: args.covers ?? null,
    p_origen: args.origen ?? 'pos',
    p_tipo_entrega: args.tipoEntrega ?? null,
    p_estado: args.estado ?? 'abierta',
    p_programada_para: args.programadaPara ?? null,
    p_cliente_id: args.clienteId ?? null,
  });
  if (error) return { ventaId: null, error: translateError(error) };
  return { ventaId: data as number, error: null };
}

export async function getVenta(ventaId: number): Promise<{ data: VentaPos | null; error: string | null }> {
  const { data, error } = await db
    .from('ventas_pos')
    .select('*')
    .eq('id', ventaId)
    .is('deleted_at', null)
    .limit(1)
    .single();
  if (error) return { data: null, error: translateError(error) };
  return { data: data as VentaPos, error: null };
}

export async function listVentasItems(ventaId: number): Promise<{ data: VentaPosItem[]; error: string | null }> {
  const { data, error } = await db
    .from('ventas_pos_items')
    .select('*')
    .eq('venta_id', ventaId)
    .is('deleted_at', null)
    .order('curso', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as VentaPosItem[], error: null };
}

export interface ListVentasFilter {
  localId: number;
  modos?: ModoVenta[];
  estados?: EstadoVenta[];
  origenes?: OrigenVenta[];
  // Sprint optimización egress 2026-05-16: por default solo últimos 30 días.
  // Mostrador/Pedidos/Salón solo necesitan ventas activas (que son recientes
  // por definición). Pasar false explícito si necesitás histórico (auditoría).
  desdeUltimosDias?: number | null;
}

export async function listVentas(f: ListVentasFilter): Promise<{ data: VentaPos[]; error: string | null }> {
  // SELECT específico (no *) — reduce egress ~50%. Columnas auditoría
  // (created_by, updated_by, anulada_motivo) se piden a demanda en
  // pantallas específicas (PedidoDetalle, anularVenta, etc).
  let q = db
    .from('ventas_pos')
    .select(`
      id, tenant_id, local_id, numero_local, modo, canal_id, mesa_id,
      mozo_id, cajero_id, cliente_nombre, cliente_telefono, cliente_direccion,
      cliente_lat, cliente_lon, cliente_id, covers, programada_para,
      origen, tipo_entrega, estado, subtotal, descuento_total, propina, total,
      abierta_at, enviada_at, cobrada_at, anulada_at, notas,
      coursing_auto, tab_nombre
    `)
    .eq('local_id', f.localId)
    .is('deleted_at', null);

  if (f.modos && f.modos.length) q = q.in('modo', f.modos);
  if (f.estados && f.estados.length) q = q.in('estado', f.estados);
  if (f.origenes && f.origenes.length) q = q.in('origen', f.origenes);

  // Filtro fecha default: últimos 30 días salvo que se pase null explícito
  const dias = f.desdeUltimosDias === undefined ? 30 : f.desdeUltimosDias;
  if (dias !== null && dias > 0) {
    const desde = new Date();
    desde.setDate(desde.getDate() - dias);
    q = q.gte('abierta_at', desde.toISOString());
  }

  q = q.order('abierta_at', { ascending: false }).limit(200);
  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as unknown as VentaPos[], error: null };
}

export interface AgregarItemArgs {
  ventaId: number;
  itemId: number;
  cantidad: number;
  curso?: number;
  modificadores?: VentaPosItemModificador[] | null;
  notas?: string | null;
  cargadoPor?: string | null;
}

export async function agregarItem(args: AgregarItemArgs): Promise<{ id: number | null; error: string | null }> {
  const { featureFlags } = await import('../lib/featureFlags');
  if (featureFlags.offlineFirstVentas) {
    const { agregarItemOffline } = await import('./offline/ventasOfflineService');
    // Necesitamos precio_unitario — el server lo derivaba de items.precio_madre.
    // Para mantener compatibilidad, lo leemos del catálogo cacheado en local.
    const { itemsRepo } = await import('@/lib/db/repositories/itemsRepo');
    const cat = await itemsRepo.getById(args.itemId);
    const precio = Number(cat?.precio_madre ?? 0);
    const { ventasRepo } = await import('@/lib/db/repositories/ventasRepo');
    const venta = await ventasRepo.getById(args.ventaId);
    try {
      const r = await agregarItemOffline({
        ventaId: args.ventaId,
        itemId: args.itemId,
        cantidad: args.cantidad,
        precioUnitario: precio,
        curso: args.curso ?? 1,
        modificadores: args.modificadores ?? undefined,
        notas: args.notas ?? null,
        cargadoPor: args.cargadoPor ?? null,
        tenantId: venta?.tenant_id ?? '',
        localId: venta?.local_id ?? 0,
      });
      return { id: r.tempItemId, error: null };
    } catch (err) {
      return { id: null, error: err instanceof Error ? err.message : 'Error agregando' };
    }
  }
  const { data, error } = await db.rpc('fn_agregar_item_comanda', {
    p_venta_id: args.ventaId,
    p_item_id: args.itemId,
    p_cantidad: args.cantidad,
    p_curso: args.curso ?? 1,
    p_modificadores: args.modificadores ?? null,
    p_notas: args.notas ?? null,
    p_cargado_por: args.cargadoPor ?? null,
  });
  if (error) return { id: null, error: translateError(error) };
  return { id: data as number, error: null };
}

export async function modificarItem(
  itemId: number,
  patch: { cantidad?: number; curso?: number; notas?: string | null },
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_modificar_item_comanda', {
    p_item_id: itemId,
    p_cantidad: patch.cantidad ?? null,
    p_curso: patch.curso ?? null,
    p_notas: patch.notas ?? null,
  });
  return { error: error?.message ?? null };
}

export async function anularItem(
  itemId: number, managerId: string, motivo: string,
  idempotencyKey?: string,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_anular_item_comanda', {
    p_item_id: itemId,
    p_manager_id: managerId,
    p_motivo: motivo,
    p_idempotency_key: idempotencyKey ?? null,
  });
  return { error: error?.message ?? null };
}

export async function mandarCurso(ventaId: number, curso: number): Promise<{ count: number; error: string | null }> {
  const { featureFlags } = await import('../lib/featureFlags');
  if (featureFlags.offlineFirstVentas) {
    const { mandarCursoOffline } = await import('./offline/ventasOfflineService');
    try {
      const r = await mandarCursoOffline(ventaId, curso);
      return { count: r.count, error: null };
    } catch (err) {
      return { count: 0, error: err instanceof Error ? err.message : 'Error mandando curso' };
    }
  }
  const { data, error } = await db.rpc('fn_mandar_curso_comanda', {
    p_venta_id: ventaId, p_curso: curso,
  });
  if (error) return { count: 0, error: translateError(error) };
  return { count: Number(data ?? 0), error: null };
}

// Sprint 2 F #1: enviar UN item específico (no el curso entero).
export async function mandarItemIndividual(itemId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_mandar_item_individual_comanda', {
    p_item_id: itemId,
  });
  if (error) return { error: translateError(error) };
  return { error: null };
}

// Sprint 2 F #1: toggle del flag stay (mantener en hold aunque se mande el curso).
// Devuelve el nuevo valor.
export async function toggleItemStay(itemId: number): Promise<{ stay: boolean | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_toggle_item_stay_comanda', {
    p_item_id: itemId,
  });
  if (error) return { stay: null, error: translateError(error) };
  return { stay: Boolean(data), error: null };
}

export async function aplicarDescuento(
  ventaId: number, monto: number, motivo: string, managerId: string | null,
  idempotencyKey?: string,
): Promise<{ error: string | null }> {
  const { featureFlags } = await import('../lib/featureFlags');
  if (featureFlags.offlineFirstVentas) {
    const { aplicarDescuentoOffline } = await import('./offline/overridesOfflineService');
    try {
      await aplicarDescuentoOffline({ ventaId, monto, motivo, managerId });
      return { error: null };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Error aplicando descuento' };
    }
  }
  const { error } = await db.rpc('fn_aplicar_descuento_comanda', {
    p_venta_id: ventaId,
    p_monto: monto,
    p_motivo: motivo,
    p_manager_id: managerId,
    p_idempotency_key: idempotencyKey ?? null,
  });
  return { error: error?.message ?? null };
}

// Sprint 16/05: actualizar campos no-financieros de la venta (notas globales,
// coursing_auto, tab_nombre). NO toca subtotal/total/estado — para eso van
// las RPCs específicas.
//
// applyLocalScope no aplica acá porque updateamos por PK (.eq('id', N)).
// RLS server-side garantiza que solo se actualice si la venta es del tenant
// + local accesible del usuario.
export interface VentaMetaPatch {
  notas?: string | null;
  coursing_auto?: boolean;
  tab_nombre?: string | null;
}

export async function updateVentaMeta(
  ventaId: number,
  patch: VentaMetaPatch,
): Promise<{ error: string | null }> {
  // eslint-disable-next-line pase-local/no-direct-financiera-write -- campos no-financieros (notas, flags UI), no afectan total/subtotal/pagos
  const { error } = await db.from('ventas_pos').update(patch).eq('id', ventaId);
  return { error: error?.message ?? null };
}

export async function anularVenta(
  ventaId: number, managerId: string, motivo: string,
  idempotencyKey?: string,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_anular_venta_comanda', {
    p_venta_id: ventaId,
    p_manager_id: managerId,
    p_motivo: motivo,
    p_idempotency_key: idempotencyKey ?? null,
  });
  if (error) return { error: error.message };
  // Si la venta vino de un partner externo, cancelar también allá.
  void notifyPartnerStatusChange(ventaId, 'cancel', { reason: motivo || 'OTHER' });
  return { error: null };
}

export async function reabrirVenta(ventaId: number, managerId: string, motivo: string): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_reabrir_venta_comanda', {
    p_venta_id: ventaId, p_manager_id: managerId, p_motivo: motivo,
  });
  return { error: error?.message ?? null };
}

export async function transferirMesa(
  ventaId: number, mesaDestino: number, managerId: string, motivo: string,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_transferir_mesa_comanda', {
    p_venta_id: ventaId, p_mesa_destino: mesaDestino, p_manager_id: managerId, p_motivo: motivo,
  });
  return { error: error?.message ?? null };
}

export async function marcarListo(ventaId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_marcar_listo_comanda', { p_venta_id: ventaId });
  if (error) return { error: error.message };
  // Fire-and-forget: email cliente + (si externo) notificar partner.
  void fetch('/api/tienda-mp?action=notify-listo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ venta_id: ventaId }),
  }).catch(() => { /* silent */ });
  void notifyPartnerStatusChange(ventaId, 'dispatch');
  return { error: null };
}

export async function marcarEntregado(ventaId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_marcar_entregado_comanda', { p_venta_id: ventaId });
  return { error: error?.message ?? null };
}

export async function aprobarPedido(ventaId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_aprobar_pedido_comanda', { p_venta_id: ventaId });
  if (error) return { error: error.message };
  // Si la venta vino de Rappi/PeYa/Deliverect, avisar al partner que aceptamos.
  void notifyPartnerStatusChange(ventaId, 'accept', { prepTimeMinutes: 30 });
  return { error: null };
}
