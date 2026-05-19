// ridersService — repartidores con tracking GPS.
//
// Patrón similar a printAgentsService: el dueño crea un rider y le pasa
// un "magic link" que el rider abre en su celu (PWA en `/r/:token`).
// La PWA postea la posición GPS cada 30s.
//
// Para admin (con auth):
//   - listRiders / listRidersStatus
//   - crearRider              → genera rider_token
//   - revocarRider (soft del)
//   - asignarPedidoRider
//   - listPedidosDeliveryMapa
//
// Para PWA del rider (sin auth, vía dbAnon):
//   - actualizarPosicion(token, lat, lon, ...)
//   - toggleOnline(token, online)
//
// Para tracking público del cliente (sin auth):
//   - getRiderPositionPublica(ventaId, telefono)

import { db } from '../lib/supabase';
import { dbAnon } from '../lib/supabaseAnon';
import { translateError } from '../lib/errors';

// ─── Types ────────────────────────────────────────────────────────────

export interface Rider {
  id: number;
  tenant_id: string;
  local_id: number;
  nombre: string;
  telefono: string | null;
  foto_url: string | null;
  activo: boolean;
  online: boolean;
  last_seen_at: string | null;
  last_lat: number | null;
  last_lon: number | null;
  last_accuracy_m: number | null;
  last_battery_pct: number | null;
  current_venta_id: number | null;
  status: 'inactivo' | 'offline' | 'sin_reportar' | 'en_linea' | 'reciente' | 'desconectado';
  pedido_numero: number | null;
  pedido_cliente: string | null;
  pedido_lat: number | null;
  pedido_lon: number | null;
  pedido_direccion: string | null;
}

export interface PedidoDeliveryMapa {
  venta_id: number;
  tenant_id: string;
  local_id: number;
  numero_local: number;
  estado: string;
  tipo_entrega: 'retiro' | 'delivery';
  cliente_nombre: string | null;
  cliente_telefono: string | null;
  cliente_direccion: string | null;
  cliente_lat: number | null;
  cliente_lon: number | null;
  programada_para: string | null;
  enviada_at: string | null;
  total: number;
  notas: string | null;
  rider_id: number | null;
  rider_nombre: string | null;
  rider_lat: number | null;
  rider_lon: number | null;
  rider_last_seen_at: string | null;
  rider_online: boolean | null;
  minutos_desde_enviada: number | null;
}

// ─── Admin: listar riders ────────────────────────────────────────────

export async function listRidersStatus(localId?: number): Promise<{ data: Rider[]; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- vista filtra por RLS
  let q = db.from('v_riders_status').select('*');
  if (localId) q = q.eq('local_id', localId);
  q = q.order('online', { ascending: false }).order('nombre', { ascending: true });
  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as Rider[], error: null };
}

export async function crearRider(args: {
  localId: number;
  nombre: string;
  telefono?: string;
  fotoUrl?: string;
}): Promise<{ data: { id: number; rider_token: string } | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_crear_delivery_rider', {
    p_local_id: args.localId,
    p_nombre: args.nombre,
    p_telefono: args.telefono ?? null,
    p_foto_url: args.fotoUrl ?? null,
  });
  if (error) return { data: null, error: translateError(error) };
  const arr = data as Array<{ id: number; rider_token: string }> | null;
  const row = arr?.[0];
  if (!row) return { data: null, error: 'Sin resultado' };
  return { data: row, error: null };
}

export async function revocarRider(id: number): Promise<{ error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- RLS filtra
  // eslint-disable-next-line pase-local/no-direct-financiera-write -- delivery_riders no es financiera
  const { error } = await db.from('delivery_riders')
    .update({ deleted_at: new Date().toISOString(), activo: false })
    .eq('id', id);
  if (error) return { error: translateError(error) };
  return { error: null };
}

export async function asignarPedidoRider(ventaId: number, riderId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_asignar_pedido_rider', {
    p_venta_id: ventaId,
    p_rider_id: riderId,
  });
  if (error) return { error: translateError(error) };
  return { error: null };
}

export async function desasignarRider(ventaId: number): Promise<{ error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- RLS filtra + es ventas_pos column update
  // eslint-disable-next-line pase-local/no-direct-financiera-write -- solo cambia rider_id, no plata
  const { data: venta, error: e1 } = await db.from('ventas_pos').select('rider_id').eq('id', ventaId).maybeSingle();
  if (e1) return { error: translateError(e1) };
  const oldRiderId = (venta as { rider_id: number | null } | null)?.rider_id;

  // eslint-disable-next-line pase-local/require-apply-local-scope -- ventas_pos: edit por id
  // eslint-disable-next-line pase-local/no-direct-financiera-write -- solo rider_id
  const { error } = await db.from('ventas_pos').update({ rider_id: null }).eq('id', ventaId);
  if (error) return { error: translateError(error) };

  if (oldRiderId) {
    // eslint-disable-next-line pase-local/require-apply-local-scope -- delivery_riders por id
    // eslint-disable-next-line pase-local/no-direct-financiera-write -- delivery_riders, current_venta_id
    await db.from('delivery_riders').update({ current_venta_id: null }).eq('id', oldRiderId);
  }
  return { error: null };
}

// ─── Admin: pedidos delivery en mapa ─────────────────────────────────

export async function listPedidosDeliveryMapa(localId?: number): Promise<{ data: PedidoDeliveryMapa[]; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- vista filtra por RLS
  let q = db.from('v_pedidos_delivery_mapa').select('*');
  if (localId) q = q.eq('local_id', localId);
  q = q.order('enviada_at', { ascending: true, nullsFirst: false });
  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as PedidoDeliveryMapa[], error: null };
}

// ─── PWA del rider (sin auth) ────────────────────────────────────────

export async function actualizarPosicionRider(args: {
  riderToken: string;
  lat: number;
  lon: number;
  accuracyM?: number;
  speedKmh?: number;
  headingDeg?: number;
  batteryPct?: number;
  capturedAt?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { error } = await dbAnon.rpc('fn_actualizar_posicion_rider', {
    p_rider_token: args.riderToken,
    p_lat: args.lat,
    p_lon: args.lon,
    p_accuracy_m: args.accuracyM ?? null,
    p_speed_kmh: args.speedKmh ?? null,
    p_heading_deg: args.headingDeg ?? null,
    p_battery_pct: args.batteryPct ?? null,
    p_captured_at: args.capturedAt ?? null,
  });
  if (error) return { ok: false, error: translateError(error) };
  return { ok: true };
}

export async function toggleRiderOnline(
  riderToken: string,
  online: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await dbAnon.rpc('fn_toggle_rider_online', {
    p_rider_token: riderToken,
    p_online: online,
  });
  if (error) return { ok: false, error: translateError(error) };
  return { ok: true };
}

// ─── PWA: info del rider por token (sin auth) ────────────────────────

export interface RiderInfoPublica {
  id: number;
  nombre: string;
  online: boolean;
  current_venta_id: number | null;
  pedido_numero: number | null;
  pedido_cliente: string | null;
  pedido_telefono: string | null;
  pedido_lat: number | null;
  pedido_lon: number | null;
  pedido_direccion: string | null;
  pedido_total: number | null;
  pedido_estado: string | null;
}

export async function getRiderInfoPublica(token: string): Promise<{ data: RiderInfoPublica | null; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_get_rider_info_publica', {
    p_rider_token: token,
  });
  if (error) return { data: null, error: translateError(error) };
  const arr = data as RiderInfoPublica[] | null;
  return { data: arr?.[0] ?? null, error: null };
}

// ─── Tracking público del cliente (sin auth) ─────────────────────────

export interface RiderPositionPublica {
  rider_nombre: string;
  rider_lat: number;
  rider_lon: number;
  rider_last_seen_at: string;
}

export async function getRiderPositionPublica(
  ventaId: number,
  telefono: string,
): Promise<{ data: RiderPositionPublica | null; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_get_rider_position_publico', {
    p_venta_id: ventaId,
    p_telefono: telefono,
  });
  if (error) return { data: null, error: translateError(error) };
  const arr = data as RiderPositionPublica[] | null;
  return { data: arr?.[0] ?? null, error: null };
}
