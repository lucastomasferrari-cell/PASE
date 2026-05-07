import { db } from '../lib/supabase';
import type {
  VentaPos, VentaPosItem, VentaPosItemModificador, ModoVenta, EstadoVenta,
  TipoEntrega, OrigenVenta,
} from '../types/database';

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
}

export async function abrirVenta(args: AbrirVentaArgs): Promise<{ ventaId: number | null; error: string | null }> {
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
  });
  if (error) return { ventaId: null, error: error.message };
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
  if (error) return { data: null, error: error.message };
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
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as VentaPosItem[], error: null };
}

export interface ListVentasFilter {
  localId: number;
  modos?: ModoVenta[];
  estados?: EstadoVenta[];
  origenes?: OrigenVenta[];
}

export async function listVentas(f: ListVentasFilter): Promise<{ data: VentaPos[]; error: string | null }> {
  let q = db.from('ventas_pos').select('*').eq('local_id', f.localId).is('deleted_at', null);
  if (f.modos && f.modos.length) q = q.in('modo', f.modos);
  if (f.estados && f.estados.length) q = q.in('estado', f.estados);
  if (f.origenes && f.origenes.length) q = q.in('origen', f.origenes);
  q = q.order('abierta_at', { ascending: false }).limit(200);
  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as VentaPos[], error: null };
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
  const { data, error } = await db.rpc('fn_agregar_item_comanda', {
    p_venta_id: args.ventaId,
    p_item_id: args.itemId,
    p_cantidad: args.cantidad,
    p_curso: args.curso ?? 1,
    p_modificadores: args.modificadores ?? null,
    p_notas: args.notas ?? null,
    p_cargado_por: args.cargadoPor ?? null,
  });
  if (error) return { id: null, error: error.message };
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
  const { data, error } = await db.rpc('fn_mandar_curso_comanda', {
    p_venta_id: ventaId, p_curso: curso,
  });
  if (error) return { count: 0, error: error.message };
  return { count: Number(data ?? 0), error: null };
}

export async function aplicarDescuento(
  ventaId: number, monto: number, motivo: string, managerId: string | null,
  idempotencyKey?: string,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_aplicar_descuento_comanda', {
    p_venta_id: ventaId,
    p_monto: monto,
    p_motivo: motivo,
    p_manager_id: managerId,
    p_idempotency_key: idempotencyKey ?? null,
  });
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
  return { error: error?.message ?? null };
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
  return { error: error?.message ?? null };
}

export async function marcarEntregado(ventaId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_marcar_entregado_comanda', { p_venta_id: ventaId });
  return { error: error?.message ?? null };
}

export async function aprobarPedido(ventaId: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_aprobar_pedido_comanda', { p_venta_id: ventaId });
  return { error: error?.message ?? null };
}
