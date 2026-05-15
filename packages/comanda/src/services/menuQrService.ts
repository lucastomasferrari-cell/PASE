import { dbAnon } from '../lib/supabaseAnon';
import { translateError } from '../lib/errors';

// Menú QR — accedido desde celular del cliente sin login. Token define
// local + mesa + modo. Las RPCs son SECURITY DEFINER + token validation.

export type MenuQrModo = 'readonly' | 'asistido' | 'autonomo';

export interface MenuQrLocal {
  local_id: number;
  local_nombre: string;
  mesa_id: number;
  mesa_numero: string;
  mesa_zona: string | null;
  modo: MenuQrModo;
}

export interface MenuQrItem {
  item_id: number;
  nombre: string;
  descripcion: string | null;
  emoji: string | null;
  foto_url: string | null;
  precio: number;
  grupo_id: number | null;
  grupo_nombre: string | null;
  grupo_emoji: string | null;
  grupo_color_ramp: string | null;
  grupo_orden: number | null;
}

export interface MenuQrPedidoItem {
  item_id: number;
  cantidad: number;
  modificadores?: { nombre: string; precio_extra: number }[];
  notas?: string;
}

export async function getLocalPorToken(token: string): Promise<{ data: MenuQrLocal | null; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_menu_qr_get_local_comanda', { p_token: token });
  if (error) return { data: null, error: translateError(error) };
  const arr = data as MenuQrLocal[] | null;
  return { data: arr?.[0] ?? null, error: null };
}

export async function getCatalogoPorToken(token: string): Promise<{ data: MenuQrItem[]; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_menu_qr_get_catalogo_comanda', { p_token: token });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as MenuQrItem[], error: null };
}

export async function crearPedidoMenuQr(args: {
  token: string;
  items: MenuQrPedidoItem[];
  idempotencyKey: string;
  notas?: string | null;
}): Promise<{ ventaId: number | null; numero: number | null; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_crear_pedido_menu_qr_comanda', {
    p_token: args.token,
    p_items: args.items,
    p_idempotency_key: args.idempotencyKey,
    p_notas: args.notas ?? null,
  });
  if (error) return { ventaId: null, numero: null, error: translateError(error) };
  const arr = data as Array<{ venta_id: number; numero_local: number }> | null;
  const row = arr?.[0];
  if (!row) return { ventaId: null, numero: null, error: 'Sin resultado' };
  return { ventaId: row.venta_id, numero: row.numero_local, error: null };
}
