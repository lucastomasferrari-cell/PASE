import { db } from '../lib/supabase';
import { dbAnon } from '../lib/supabaseAnon';
import type { TipoEntrega, VentaPos } from '../types/database';
import { translateError } from '../lib/errors';

// Vista pública del catálogo de tienda online. Lectura anon (RLS no aplica a vistas).

export interface CatalogoPublicoItem {
  item_id: number;
  nombre: string;
  descripcion: string | null;
  emoji: string | null;
  foto_url: string | null;
  precio: number;
  canal_id: number;
  grupo_id: number | null;
  grupo_nombre: string | null;
  grupo_emoji: string | null;
  grupo_color_ramp: string | null;
  local_id: number;
  local_slug: string;
  /** F6 chunk item-detalle (2026-06-02): si TRUE el frontend abre pantalla
   *  /tienda/:slug/item/:id en vez de agregar +1 directo al carrito. */
  tiene_modificadores: boolean;
}

// ─── Modificadores públicos (Fase 6 chunk detalle) ───────────────────────
//
// El backend (`fn_get_modificadores_publico`) devuelve filas flat por
// (group, modifier). Acá las agrupamos en una estructura anidada para
// que la UI itere directo. Cada group con sus modifiers ordenados.

export interface ModifierPublico {
  modifier_id: number;
  nombre: string;
  precio_extra: number;
  orden: number;
}

export interface ModifierGroupPublico {
  modifier_group_id: number;
  nombre: string;
  descripcion: string | null;
  tipo: 'opcion' | 'extra' | 'aclaracion' | 'sin_con';
  requerido: boolean;
  min_seleccion: number;
  max_seleccion: number | null;
  orden: number;
  modifiers: ModifierPublico[];
}

export interface LocalPublico {
  local_id: number;
  slug: string;
  nombre: string;
  direccion: string | null;
  telefono: string | null;
  instagram: string | null;
  web: string | null;
  mp_qr_url: string | null;
  costo_envio_default: number;
  tiempo_retiro_min: number;
  tiempo_delivery_min: number;
  tienda_activa: boolean;
  acepta_delivery: boolean;
  features_pos_modos: string[] | null;
  // Sprint 2026-05-16: filtros geo para autocomplete
  provincia?: string | null;
  localidad?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** Radio max delivery en km. NULL = sin límite. Fase B 2026-05-18. */
  radio_delivery_km?: number | null;
}

export async function getLocalPorSlug(slug: string): Promise<{ data: LocalPublico | null; error: string | null }> {
  // dbAnon: la tienda online se accede sin login. v_locales_publicos tiene
  // GRANT a anon.
  const { data, error } = await dbAnon
    .from('v_locales_publicos')
    .select('*')
    .eq('slug', slug)
    .limit(1);
  if (error) return { data: null, error: translateError(error) };
  return { data: (data?.[0] as LocalPublico | undefined) ?? null, error: null };
}

export async function getCatalogoPorSlug(slug: string): Promise<{ data: CatalogoPublicoItem[]; error: string | null }> {
  const { data, error } = await dbAnon
    .from('v_catalogo_publico')
    .select('*')
    .eq('local_slug', slug)
    .order('grupo_id', { ascending: true, nullsFirst: false })
    .order('nombre', { ascending: true });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as CatalogoPublicoItem[], error: null };
}

// Busca un ítem específico del catálogo público (para pantalla detalle).
// Reutiliza la misma vista: si retorna nada, el item no es público en ese
// slug (puede no existir, estar agotado, estar oculto, etc).
export async function getItemPublico(
  slug: string,
  itemId: number,
): Promise<{ data: CatalogoPublicoItem | null; error: string | null }> {
  const { data, error } = await dbAnon
    .from('v_catalogo_publico')
    .select('*')
    .eq('local_slug', slug)
    .eq('item_id', itemId)
    .limit(1);
  if (error) return { data: null, error: translateError(error) };
  return { data: (data?.[0] as CatalogoPublicoItem | undefined) ?? null, error: null };
}

// Trae modifier_groups + modifiers asignados al ítem. Si el item no es
// visible en la tienda del slug, la RPC retorna [] (anti-enumeration).
// Agrupa los rows flat del server en una estructura nested.
export async function getModificadoresPublico(
  slug: string,
  itemId: number,
): Promise<{ data: ModifierGroupPublico[]; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_get_modificadores_publico', {
    p_item_id: itemId,
    p_local_slug: slug,
  });
  if (error) return { data: [], error: translateError(error) };

  const rows = (data ?? []) as Array<{
    modifier_group_id: number;
    group_nombre: string;
    group_descripcion: string | null;
    group_tipo: 'opcion' | 'extra' | 'aclaracion' | 'sin_con';
    requerido: boolean;
    min_seleccion: number;
    max_seleccion: number | null;
    group_orden: number;
    modifier_id: number | null;
    modifier_nombre: string | null;
    modifier_precio_extra: string | number | null;
    modifier_orden: number | null;
  }>;

  const map = new Map<number, ModifierGroupPublico>();
  for (const r of rows) {
    let g = map.get(r.modifier_group_id);
    if (!g) {
      g = {
        modifier_group_id: r.modifier_group_id,
        nombre: r.group_nombre,
        descripcion: r.group_descripcion,
        tipo: r.group_tipo,
        requerido: r.requerido,
        min_seleccion: r.min_seleccion,
        max_seleccion: r.max_seleccion,
        orden: r.group_orden,
        modifiers: [],
      };
      map.set(r.modifier_group_id, g);
    }
    // LEFT JOIN: si el group no tiene modifiers activos vienen NULL.
    if (r.modifier_id != null) {
      g.modifiers.push({
        modifier_id: r.modifier_id,
        nombre: r.modifier_nombre ?? '',
        precio_extra: Number(r.modifier_precio_extra) || 0,
        orden: r.modifier_orden ?? 0,
      });
    }
  }

  return { data: Array.from(map.values()), error: null };
}

// ETA dinámico — recalcula tiempo de espera según cola actual del local.
// Public (anon) porque se usa en checkout sin login.
export interface ETACalculado {
  eta_minutos: number;
  tiempo_base: number;
  pedidos_en_cola: number;
  incremento_por_pedido: number;
}

export async function calcularETALocal(
  slug: string,
  tipoEntrega: 'retiro' | 'delivery',
): Promise<{ data: ETACalculado | null; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_calcular_eta_local', {
    p_local_slug: slug,
    p_tipo_entrega: tipoEntrega,
  });
  if (error) return { data: null, error: translateError(error) };
  const arr = data as ETACalculado[] | null;
  return { data: arr?.[0] ?? null, error: null };
}

// Tracking público — cliente verifica con su número de teléfono.
export interface PedidoPublicoEstado {
  estado: string;
  numero_local: number;
  total: number;
  programada_para: string | null;
  tipo_entrega: string | null;
  abierta_at: string;
  rechazo_motivo: string | null;
}

export async function getPedidoPublico(ventaId: number, telefono: string): Promise<{ data: PedidoPublicoEstado | null; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_get_pedido_publico_comanda', {
    p_venta_id: ventaId, p_telefono: telefono,
  });
  if (error) return { data: null, error: translateError(error) };
  const arr = data as PedidoPublicoEstado[] | null;
  return { data: arr?.[0] ?? null, error: null };
}

export interface CrearPedidoArgs {
  localSlug: string;
  cliente: { nombre: string; telefono: string; email: string | null };
  tipoEntrega: TipoEntrega;
  direccion: string | null;
  items: Array<{
    item_id: number;
    cantidad: number;
    modificadores?: { nombre: string; precio_extra: number }[];
    notas?: string;
  }>;
  metodoPagoPreferido: string;
  notas?: string | null;
  /** Si el cliente programó el pedido para una fecha+hora futura. ISO timestamp.
   *  Si es null, el pedido es "lo antes posible". */
  programadaPara?: string | null;
  /** Idempotency key (UUID) para evitar doble click. Server-side cachea el
   *  primer resultado y devuelve el mismo si llega misma key. */
  idempotencyKey?: string | null;
}

export async function crearPedidoPublico(args: CrearPedidoArgs): Promise<{ ventaId: number | null; numero: number | null; error: string | null }> {
  // dbAnon — la tienda no requiere login. fn_crear_pedido_publico_comanda
  // es SECURITY DEFINER y valida slug + features_pos_modos.
  const { data, error } = await dbAnon.rpc('fn_crear_pedido_publico_comanda', {
    p_local_slug: args.localSlug,
    p_cliente_nombre: args.cliente.nombre,
    p_cliente_telefono: args.cliente.telefono,
    p_cliente_email: args.cliente.email,
    p_tipo_entrega: args.tipoEntrega,
    p_cliente_direccion: args.direccion,
    p_items: args.items,
    p_metodo_pago_preferido: args.metodoPagoPreferido,
    p_notas: args.notas ?? null,
    p_programada_para: args.programadaPara ?? null,
    p_idempotency_key: args.idempotencyKey ?? null,
  });
  if (error) return { ventaId: null, numero: null, error: translateError(error) };
  const arr = data as Array<{ venta_id: number; numero_local: number }> | null;
  const row = arr?.[0];
  if (!row) return { ventaId: null, numero: null, error: 'Sin resultado' };
  return { ventaId: row.venta_id, numero: row.numero_local, error: null };
}

// ─── Sprint 5: Populares + Discounts ─────────────────────────────────────

export interface PopularItem {
  item_id: number;
  nombre: string;
  descripcion: string | null;
  emoji: string | null;
  foto_url: string | null;
  precio_canal: number;
  grupo_id: number | null;
  grupo_nombre: string | null;
  grupo_color_ramp: string | null;
  cantidad_vendida: number;
}

// Populares para sección "Popular" de Tienda online. Mira ventas reales
// de los últimos `dias` días. Si no alcanza, el frontend hace fallback
// a items con destacado_tienda=TRUE (filtra del catálogo cargado).
export async function getPopulares(
  slug: string,
  dias = 30,
  limit = 8,
): Promise<{ data: PopularItem[]; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_get_populares_tienda_comanda', {
    p_local_slug: slug,
    p_dias: dias,
    p_limit: limit,
  });
  if (error) return { data: [], error: translateError(error) };
  const rows = (data ?? []) as Array<{
    item_id: number;
    nombre: string;
    descripcion: string | null;
    emoji: string | null;
    foto_url: string | null;
    precio_canal: string | number;
    grupo_id: number | null;
    grupo_nombre: string | null;
    grupo_color_ramp: string | null;
    cantidad_vendida: string | number;
  }>;
  return {
    data: rows.map((r) => ({
      ...r,
      precio_canal: Number(r.precio_canal),
      cantidad_vendida: Number(r.cantidad_vendida),
    })),
    error: null,
  };
}

/**
 * @deprecated Stub hasta implementar sistema de promociones/discounts
 * (sprint dedicado). Por ahora devuelve [] siempre. El frontend oculta
 * la sección "Discounts" de la Tienda online si data.length === 0.
 *
 * Cuando se implemente:
 *   1. Crear tabla `descuentos_tienda` con start_at, end_at, tipo
 *      (porcentaje/monto), valor, items_aplicables.
 *   2. Agregar parámetro `slug: string` y consultar la tabla.
 *   3. Eliminar este JSDoc.
 *
 * Anotado en DEUDA_TECNICA.md (Sprint 5).
 */
export async function getDescuentos(): Promise<{ data: PopularItem[]; error: string | null }> {
  return { data: [], error: null };
}

export async function listPedidosPorAprobar(localId: number): Promise<{ data: VentaPos[]; error: string | null }> {
  const { data, error } = await db
    .from('ventas_pos')
    .select('*')
    .eq('local_id', localId)
    .eq('origen', 'tienda_online')
    .eq('estado', 'necesita_aprobacion')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as VentaPos[], error: null };
}

// Fase B item 3 — disparar email "Recibimos tu pedido" al cliente.
// Idempotente server-side: si el endpoint ya envió este pedido, devuelve
// skipped=YA_ENVIADO sin re-enviar. Si Resend falla, no rompemos el flow
// del cliente (mejor que el pedido siga sin email a que tire error).
export async function notificarPedidoRecibido(args: {
  ventaId: number;
  email: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch('/api/tienda-mp?action=notify-pedido', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        venta_id: args.ventaId,
        email_destinatario: args.email,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.warn('[notif-pedido] non-ok:', resp.status, detail);
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[notif-pedido] fetch threw:', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Llamado desde el POS cuando alguien marca venta como 'lista'. Mismo
// patrón idempotente. Email opcional: si no se pasa, el endpoint lee
// ventas_pos.cliente_email; si tampoco hay ahí, skip silencioso.
export async function notificarPedidoListo(args: {
  ventaId: number;
  email?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch('/api/tienda-mp?action=notify-listo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        venta_id: args.ventaId,
        email_destinatario: args.email,
      }),
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Gap #4 marketplace — pedido rechazado / cancelado por el comerciante.
// Lo dispara el POS cuando alguien anula (estado → anulada) un pedido
// origen=tienda_online. El motivo se incluye en el email para que el
// cliente entienda por qué.
export async function notificarPedidoRechazado(args: {
  ventaId: number;
  motivo?: string;
  email?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch('/api/tienda-mp?action=notify-rechazado', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        venta_id: args.ventaId,
        motivo: args.motivo ?? null,
        email_destinatario: args.email,
      }),
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Gap #4 marketplace — pedido entregado, invitación a calificar.
// Lo dispara el POS cuando la venta pasa a entregada/cobrada. El email
// trae link a la página de confirmación donde aparece el ReviewForm.
export async function notificarPedidoEntregado(args: {
  ventaId: number;
  email?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch('/api/tienda-mp?action=notify-entregado', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        venta_id: args.ventaId,
        email_destinatario: args.email,
      }),
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
