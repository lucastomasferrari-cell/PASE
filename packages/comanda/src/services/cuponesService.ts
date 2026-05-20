// cuponesService — gestión de cupones de descuento.
//
// Para cliente público (anon):
//   - validarCupon (devuelve descuento que aplicaría sin aplicar)
//
// Para admin:
//   - listCupones / crearCupon / actualizarCupon / eliminarCupon

import { db } from '../lib/supabase';
import { dbAnon } from '../lib/supabaseAnon';
import { translateError } from '../lib/errors';

export interface Cupon {
  id: number;
  tenant_id: string;
  local_id: number | null;
  code: string;
  descripcion: string | null;
  tipo: 'porcentaje' | 'monto_fijo';
  valor: number;
  cap_descuento: number | null;
  fecha_desde: string | null;
  fecha_hasta: string | null;
  monto_min_compra: number | null;
  max_usos: number | null;
  max_usos_por_cliente: number | null;
  solo_primera_compra: boolean;
  activo: boolean;
  usos_actuales: number;
  created_at: string;
}

export interface CuponInput {
  localId?: number;
  code: string;
  descripcion?: string;
  tipo: 'porcentaje' | 'monto_fijo';
  valor: number;
  capDescuento?: number;
  fechaDesde?: string;
  fechaHasta?: string;
  montoMinCompra?: number;
  maxUsos?: number;
  maxUsosPorCliente?: number;
  soloPrimeraCompra?: boolean;
}

export interface ValidacionCupon {
  valido: boolean;
  motivo: string;
  descuento: number;
  cupon_id: number | null;
}

// ─── Public ───────────────────────────────────────────────────────────

export async function validarCupon(args: {
  slug: string;
  code: string;
  montoCompra: number;
  clienteTelefono?: string;
}): Promise<{ data: ValidacionCupon | null; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_validar_cupon', {
    p_local_slug: args.slug,
    p_code: args.code,
    p_monto_compra: args.montoCompra,
    p_cliente_telefono: args.clienteTelefono ?? null,
  });
  if (error) return { data: null, error: translateError(error) };
  const arr = data as ValidacionCupon[] | null;
  return { data: arr?.[0] ?? null, error: null };
}

// ─── Admin ────────────────────────────────────────────────────────────

export async function listCupones(localId?: number): Promise<{ data: Cupon[]; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- RLS filtra
  let q = db.from('cupones').select('*').is('deleted_at', null);
  if (localId !== undefined) {
    q = q.or(`local_id.is.null,local_id.eq.${localId}`);
  }
  q = q.order('created_at', { ascending: false });
  const { data, error } = await q;
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as Cupon[], error: null };
}

export async function crearCupon(input: CuponInput): Promise<{ data: Cupon | null; error: string | null }> {
  const tenantId = await getTenantId();
  if (!tenantId) return { data: null, error: 'No autenticado' };
  // eslint-disable-next-line pase-local/require-apply-local-scope -- master data por tenant
  const { data, error } = await db.from('cupones').insert({
    tenant_id: tenantId,
    local_id: input.localId ?? null,
    code: input.code.trim().toUpperCase(),
    descripcion: input.descripcion ?? null,
    tipo: input.tipo,
    valor: input.valor,
    cap_descuento: input.capDescuento ?? null,
    fecha_desde: input.fechaDesde ?? null,
    fecha_hasta: input.fechaHasta ?? null,
    monto_min_compra: input.montoMinCompra ?? null,
    max_usos: input.maxUsos ?? null,
    max_usos_por_cliente: input.maxUsosPorCliente ?? null,
    solo_primera_compra: !!input.soloPrimeraCompra,
  }).select().single();
  if (error) return { data: null, error: translateError(error) };
  return { data: data as Cupon, error: null };
}

export async function actualizarCupon(id: number, patch: Partial<Cupon>): Promise<{ error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- por id, RLS valida
  const { error } = await db.from('cupones').update(patch).eq('id', id);
  if (error) return { error: translateError(error) };
  return { error: null };
}

export async function eliminarCupon(id: number): Promise<{ error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- por id, RLS valida
  const { error } = await db.from('cupones')
    .update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) return { error: translateError(error) };
  return { error: null };
}

async function getTenantId(): Promise<string | null> {
  const stored = sessionStorage.getItem('pase_user');
  if (!stored) return null;
  try {
    const user = JSON.parse(stored);
    return user.tenant_id ?? null;
  } catch {
    return null;
  }
}
