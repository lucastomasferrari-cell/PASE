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
    // Rebuild offline2 (estilo Toast): escribe el store local RxDB al instante y
    // devuelve un tempId negativo. El push (sync.ts) lo materializa en Supabase
    // vía las RPCs `_offline`; al reconciliar el id real, OfflineProvider emite
    // `comanda:reconcile-id` y la pantalla navega al id real.
    try {
      const { abrirVentaLocal } = await import('../lib/offline2/bridge');
      const tempId = await abrirVentaLocal({
        localId: args.localId,
        canalId: args.canalId,
        modo: args.modo,
        mesaId: args.mesaId ?? null,
        mozoId: args.mozoId ?? null,
        cajeroId: args.cajeroId ?? null,
      });
      return { ventaId: tempId, error: null };
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

// Routing offline-first: si el id es negativo, la venta vive SOLO en idb
// local (creada offline o aún no sincronizada). Bug Anto 2026-06-02: hasta
// hoy esto rompía con "Cannot coerce" porque Supabase no tenía esa fila.
// Fix: leer del repo local cuando id < 0.
export async function getVenta(ventaId: number): Promise<{ data: VentaPos | null; error: string | null }> {
  if (ventaId < 0) {
    const { featureFlags } = await import('../lib/featureFlags');
    if (featureFlags.offlineFirstVentas) {
      const { getVentaLocal } = await import('../lib/offline2/bridge');
      const local = await getVentaLocal(ventaId);
      if (!local) return { data: null, error: 'VENTA_LOCAL_NO_ENCONTRADA' };
      return { data: local, error: null };
    }
    const { ventasRepo } = await import('@/lib/db/repositories/ventasRepo');
    const local = await ventasRepo.getById(ventaId);
    if (!local) return { data: null, error: 'VENTA_LOCAL_NO_ENCONTRADA' };
    return { data: local as unknown as VentaPos, error: null };
  }
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
  // Mismo patrón: venta_id negativo → leer items del store local
  if (ventaId < 0) {
    const { featureFlags } = await import('../lib/featureFlags');
    if (featureFlags.offlineFirstVentas) {
      const { listItemsLocal } = await import('../lib/offline2/bridge');
      return { data: await listItemsLocal(ventaId), error: null };
    }
    const { ventasItemsRepo } = await import('@/lib/db/repositories/ventasRepo');
    const items = await ventasItemsRepo.listByVenta(ventaId);
    // Sort: curso ASC (nulls last) → id ASC (mismo orden que la query remote)
    const sorted = [...items].sort((a, b) => {
      const ca = a.curso ?? Number.MAX_SAFE_INTEGER;
      const cb = b.curso ?? Number.MAX_SAFE_INTEGER;
      if (ca !== cb) return ca - cb;
      return a.id - b.id;
    });
    return { data: sorted as unknown as VentaPosItem[], error: null };
  }
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
  const remotas = (data ?? []) as unknown as VentaPos[];

  // Offline-first merge (Anto 2026-06-02): si hay ventas locales no
  // sincronizadas (id < 0) en este local, agregarlas al listado para que
  // aparezcan en Mostrador/Salón/Pedidos. Dedup por idempotency_uuid si
  // ya están en remotas (caso edge: sincronizó pero el cliente todavía
  // no recibió el evento reconcile).
  try {
    const { featureFlags } = await import('../lib/featureFlags');
    if (!featureFlags.offlineFirstVentas) return { data: remotas, error: null };

    const { ventasRepo } = await import('@/lib/db/repositories/ventasRepo');
    const locales = await ventasRepo.listByLocal(f.localId);
    if (locales.length === 0) return { data: remotas, error: null };

    // Filtros equivalentes a los aplicados al servidor (modos, estados, origenes, fecha)
    const cutoff = (() => {
      const dias = f.desdeUltimosDias === undefined ? 30 : f.desdeUltimosDias;
      if (dias === null || dias <= 0) return null;
      const d = new Date();
      d.setDate(d.getDate() - dias);
      return d.toISOString();
    })();
    const localesPendientes = locales.filter((v) => {
      // Solo las que NO están en remotas (todavía no sincronizadas)
      const yaSync = remotas.some((r) => {
        const ruuid = (r as { idempotency_uuid?: string | null }).idempotency_uuid;
        const luuid = (v as { idempotency_uuid?: string | null }).idempotency_uuid;
        return luuid && ruuid && luuid === ruuid;
      });
      if (yaSync) return false;
      // Aplicar mismos filtros que server-side
      if (f.modos && f.modos.length && !f.modos.includes(v.modo)) return false;
      if (f.estados && f.estados.length && !f.estados.includes(v.estado)) return false;
      if (f.origenes && f.origenes.length && v.origen && !f.origenes.includes(v.origen)) return false;
      if (cutoff && v.abierta_at && v.abierta_at < cutoff) return false;
      return true;
    });

    const merged = [...localesPendientes as unknown as VentaPos[], ...remotas]
      .sort((a, b) => (b.abierta_at ?? '').localeCompare(a.abierta_at ?? ''))
      .slice(0, 200);

    return { data: merged, error: null };
  } catch {
    // Si el merge falla por cualquier motivo, devolvemos al menos las remotas
    return { data: remotas, error: null };
  }
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
    // Rebuild offline2: escribe el ítem en el store local al instante.
    // El precio lo derivaba el server de items.precio_madre; offline lo leemos
    // del catálogo cacheado (read-only, seguro). TODO Fase 2: catálogo en offline2.
    const { itemsRepo } = await import('@/lib/db/repositories/itemsRepo');
    const cat = await itemsRepo.getById(args.itemId);
    const precio = Number(cat?.precio_madre ?? 0);
    try {
      const { agregarItemLocal } = await import('../lib/offline2/bridge');
      const tempItemId = await agregarItemLocal(args.ventaId, {
        itemId: args.itemId, cantidad: args.cantidad, precioUnitario: precio, curso: args.curso ?? 1,
      });
      if (tempItemId == null) return { id: null, error: 'VENTA_LOCAL_NO_ENCONTRADA' };
      return { id: tempItemId, error: null };
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
  patch: { cantidad?: number; curso?: number; notas?: string | null; nombre_display?: string | null; precio_unitario?: number },
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_modificar_item_comanda', {
    p_item_id: itemId,
    p_cantidad: patch.cantidad ?? null,
    p_curso: patch.curso ?? null,
    p_notas: patch.notas ?? null,
    p_nombre_display: patch.nombre_display ?? null,
    p_precio_unitario: patch.precio_unitario ?? null,
  });
  return { error: error?.message ?? null };
}

/**
 * Order-by-seat: asigna un ítem a un comensal (seat). `comensal=0` lo vuelve a
 * compartido (sin asignar). No toca cocina ni totales — solo agrupa la cuenta.
 */
export async function asignarComensalItem(
  itemId: number, comensal: number,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_asignar_comensal_item', {
    p_item_id: itemId,
    p_comensal: comensal,
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

/**
 * Quita un item EN HOLD (todavía no enviado a cocina). Soft-delete sin
 * requerir manager. Para items ya enviados usar anularItem (que pide
 * manager override + motivo).
 *
 * Fix bug 28-jun: antes el "tacho" llamaba modificarItem con cantidad=0,
 * lo que dejaba la fila visible en la lista con cantidad 0. Ahora la
 * RPC fn_quitar_item_hold_comanda hace soft-delete real.
 */
export async function quitarItemHold(itemId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_quitar_item_hold_comanda', {
    p_item_id: itemId,
  });
  return { error: error?.message ?? null };
}

export async function mandarCurso(ventaId: number, curso: number): Promise<{ count: number; error: string | null }> {
  const { featureFlags } = await import('../lib/featureFlags');
  if (featureFlags.offlineFirstVentas) {
    const { mandarCursoOffline } = await import('./offline/ventasOfflineService');
    try {
      const r = await mandarCursoOffline(ventaId, curso);
      // Fire-and-forget impresión de cocina si hay impresora configurada
      void imprimirCocinaSiCorresponde(ventaId, curso);
      return { count: r.count, error: null };
    } catch (err) {
      return { count: 0, error: err instanceof Error ? err.message : 'Error mandando curso' };
    }
  }
  const { data, error } = await db.rpc('fn_mandar_curso_comanda', {
    p_venta_id: ventaId, p_curso: curso,
  });
  if (error) return { count: 0, error: translateError(error) };
  // Fire-and-forget impresión de cocina. Si falla, el KDS digital sigue
  // teniendo el ticket — el operador no pierde el pedido.
  void imprimirCocinaSiCorresponde(ventaId, curso);
  return { count: Number(data ?? 0), error: null };
}

// Helper interno: agrupa items del curso por estación y dispara impresión
// a cada impresora correspondiente via printerService (que rutea por
// estación cuando hay print server, o fallback a WebUSB).
//
// Idempotency key determinista: `cocina-${ventaId}-c${curso}-${estacion}` o
// `cocina-${ventaId}-c${curso}-${estacion}-r${retryToken}` si se fuerza
// reimpresión (botón "Reimprimir" del POS).
export async function imprimirCocinaSiCorresponde(
  ventaId: number,
  curso: number,
  options: { retryToken?: string } = {},
): Promise<void> {
  try {
    const { imprimirPorEstacion } = await import('./printerService');
    // Cuando curso === 0 (sentinel) = "imprimir TODOS los cursos enviados".
    // Se usa al aprobar pedidos del marketplace donde los items van directo
    // a 'enviado' sin pasar por mandar-curso manual.
    let q = db.from('ventas_pos_items')
      .select('item_id, cantidad, curso, modificadores, notas, items(nombre, estacion)')
      .eq('venta_id', ventaId)
      .eq('estado', 'enviado')
      .is('deleted_at', null);
    if (curso > 0) q = q.eq('curso', curso);
    const { data: items } = await q;
    if (!items || items.length === 0) return;

    // Agrupar por (estación, curso). Supabase devuelve la relación items
    // como array (PostgREST infiere FK to-many por defecto).
    type ItemRowJoined = {
      item_id: number;
      cantidad: number;
      curso: number;
      modificadores: Array<{ nombre: string }> | null;
      notas: string | null;
      items: { nombre: string; estacion: string | null } | { nombre: string; estacion: string | null }[] | null;
    };
    const porEstacionCurso = new Map<
      string,
      { estacion: string; curso: number; items: Array<{ cantidad: number; nombre: string; notas: string | null; modificadores: string[] | null }> }
    >();
    for (const it of items as unknown as ItemRowJoined[]) {
      const linked = Array.isArray(it.items) ? it.items[0] : it.items;
      const estacion = linked?.estacion || 'cocina_caliente';
      const itemCurso = Number(it.curso) || 1;
      const key = `${estacion}|${itemCurso}`;
      if (!porEstacionCurso.has(key)) {
        porEstacionCurso.set(key, { estacion, curso: itemCurso, items: [] });
      }
      porEstacionCurso.get(key)!.items.push({
        cantidad: Number(it.cantidad),
        nombre: linked?.nombre ?? `Item ${it.item_id}`,
        notas: it.notas,
        modificadores: it.modificadores ? it.modificadores.map((m) => m.nombre) : null,
      });
    }

    const { data: venta } = await db.from('ventas_pos')
      .select('numero_local, mesa_id')
      .eq('id', ventaId)
      .single();
    const mesaStr = venta?.mesa_id ? String(venta.mesa_id) : undefined;
    const retrySuffix = options.retryToken ? `-r${options.retryToken}` : '';

    // Imprimir en paralelo a cada (estación, curso)
    await Promise.all(Array.from(porEstacionCurso.values()).map(async ({ estacion, curso: c, items: itemList }) => {
      const idempotencyKey = `cocina-${ventaId}-c${c}-${estacion}${retrySuffix}`;
      const r = await imprimirPorEstacion(estacion, {
        tipo: 'cocina',
        estacion,
        mesa: mesaStr,
        items: itemList,
        curso: c,
        fechaHora: new Date().toLocaleString('es-AR'),
      }, idempotencyKey);
      if (!r.ok) {
        console.warn(`[print kitchen] estación ${estacion} curso ${c} falló: ${r.error}`);
      }
    }));
  } catch (err) {
    console.warn('[print kitchen] error inesperado:', err);
  }
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
  // Rebuild offline2 (Fase 2): si la venta es local (id<0, sin sincronizar),
  // se anula en el store local y se encola la operación (outbox) → el sync la
  // empuja vía fn_anular_venta_comanda_offline. Las ya sincronizadas (id>0)
  // van por el flujo online de abajo. Mismo patrón que pagosService.cobrar.
  const { featureFlags } = await import('../lib/featureFlags');
  if (featureFlags.offlineFirstVentas && ventaId < 0) {
    try {
      const { anularLocal } = await import('../lib/offline2/bridge');
      const r = await anularLocal(ventaId, { managerId, motivo });
      return { error: r.error }; // venta temp: no existe en el partner externo → sin notif
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Error anulando offline' };
    }
  }

  // Flujo legacy online-only
  const { error } = await db.rpc('fn_anular_venta_comanda', {
    p_venta_id: ventaId,
    p_manager_id: managerId,
    p_motivo: motivo,
    p_idempotency_key: idempotencyKey ?? null,
  });
  if (error) return { error: error.message };
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
  // Imprimir comanda de cocina — los items ya están en 'enviado' tras aprobar.
  // curso=0 = todos los cursos del pedido. Idempotency: si se aprueba dos
  // veces, no se duplica el ticket gracias a la key determinista.
  void imprimirCocinaSiCorresponde(ventaId, 0);
  return { error: null };
}

/**
 * Reimprime la comanda completa de un pedido (todos los cursos enviados).
 * Usa un retryToken (timestamp) para que la idempotency_key sea distinta
 * y el server SÍ reimprima en lugar de detectar duplicado.
 *
 * Caso de uso: papel atascado, comanda perdida, dudas de cocina.
 */
export async function reimprimirComanda(ventaId: number): Promise<{ error: string | null }> {
  try {
    await imprimirCocinaSiCorresponde(ventaId, 0, {
      retryToken: String(Date.now()),
    });
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Error reimprimiendo' };
  }
}
