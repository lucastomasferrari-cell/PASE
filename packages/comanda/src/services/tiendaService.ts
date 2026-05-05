import { db } from '../lib/supabase';
import { dbAnon } from '../lib/supabaseAnon';
import type { TipoEntrega, VentaPos } from '../types/database';

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
  local_id: number;
  local_slug: string;
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
}

export async function getLocalPorSlug(slug: string): Promise<{ data: LocalPublico | null; error: string | null }> {
  // dbAnon: la tienda online se accede sin login. v_locales_publicos tiene
  // GRANT a anon.
  const { data, error } = await dbAnon
    .from('v_locales_publicos')
    .select('*')
    .eq('slug', slug)
    .limit(1);
  if (error) return { data: null, error: error.message };
  return { data: (data?.[0] as LocalPublico | undefined) ?? null, error: null };
}

export async function getCatalogoPorSlug(slug: string): Promise<{ data: CatalogoPublicoItem[]; error: string | null }> {
  const { data, error } = await dbAnon
    .from('v_catalogo_publico')
    .select('*')
    .eq('local_slug', slug)
    .order('grupo_id', { ascending: true, nullsFirst: false })
    .order('nombre', { ascending: true });
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as CatalogoPublicoItem[], error: null };
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
  if (error) return { data: null, error: error.message };
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
  });
  if (error) return { ventaId: null, numero: null, error: error.message };
  const arr = data as Array<{ venta_id: number; numero_local: number }> | null;
  const row = arr?.[0];
  if (!row) return { ventaId: null, numero: null, error: 'Sin resultado' };
  return { ventaId: row.venta_id, numero: row.numero_local, error: null };
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
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as VentaPos[], error: null };
}
