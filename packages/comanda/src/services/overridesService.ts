import { db } from '../lib/supabase';
import type { VentaPosOverride } from '../types/database';
import { translateError } from '../lib/errors';

// Auditoría visible. La INSERT pasa exclusivamente por las RPCs (security definer)
// que usan ManagerOverrideDialog en UI.

export async function listOverridesVenta(ventaId: number): Promise<{ data: VentaPosOverride[]; error: string | null }> {
  const { data, error } = await db
    .from('ventas_pos_overrides')
    .select('*')
    .eq('venta_id', ventaId)
    .order('created_at', { ascending: false });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as VentaPosOverride[], error: null };
}

export async function listOverridesLocal(localId: number, days = 90): Promise<{ data: VentaPosOverride[]; error: string | null }> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await db
    .from('ventas_pos_overrides')
    .select('*')
    .eq('local_id', localId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as VentaPosOverride[], error: null };
}

// ─── Sprint 4: helpers para flow de Manager Override ──────────────────────

// Verifica PIN del manager: usa fn_verificar_pin_pos del Sprint 2 + chequea
// que el rol_pos sea manager o dueno (o superadmin via bypass dueño).
export async function verificarPinManager(
  localId: number,
  pin: string,
): Promise<{ empleadoId: string | null; error: string | null }> {
  if (!/^\d{4}$/.test(pin)) return { empleadoId: null, error: 'PIN inválido' };
  const { data, error } = await db.rpc('fn_verificar_pin_pos', {
    p_local_id: localId, p_pin: pin,
  });
  if (error) return { empleadoId: null, error: translateError(error) };
  const id = data as string | null;
  if (!id) return { empleadoId: null, error: 'PIN incorrecto' };
  // Chequear rol manager+
  const { data: emp, error: empErr } = await db
    .from('rrhh_empleados')
    .select('rol_pos')
    .eq('id', id)
    .single();
  if (empErr || !emp) return { empleadoId: null, error: empErr?.message ?? 'Empleado no encontrado' };
  const rol = (emp as { rol_pos: string | null }).rol_pos;
  if (rol !== 'manager' && rol !== 'dueno') {
    return { empleadoId: null, error: 'PIN no corresponde a un manager' };
  }
  return { empleadoId: id, error: null };
}

// Anular item con manager override (Sprint 2 RPC + sprint 7 idempotency)
export async function anularItem(
  itemId: number,
  managerId: string,
  motivo: string,
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

// Anular venta entera con manager override
export async function anularVenta(
  ventaId: number,
  managerId: string,
  motivo: string,
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

// Sprint 16/05: modificar precio puntual de un item con manager override
export async function modificarPrecioItem(
  itemId: number,
  nuevoPrecio: number,
  managerId: string,
  motivo: string,
  idempotencyKey?: string,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_modificar_precio_item_comanda', {
    p_item_id: itemId,
    p_nuevo_precio: nuevoPrecio,
    p_manager_id: managerId,
    p_motivo: motivo,
    p_idempotency_key: idempotencyKey ?? null,
  });
  return { error: error?.message ?? null };
}

// Marca item como cortesía (precio_unitario=0 + es_cortesia=true).
export async function cortesiaItem(
  itemId: number,
  managerId: string,
  motivo: string,
  idempotencyKey?: string,
): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_cortesia_item_comanda', {
    p_item_id: itemId,
    p_manager_id: managerId,
    p_motivo: motivo,
    p_idempotency_key: idempotencyKey ?? null,
  });
  return { error: error?.message ?? null };
}

// IP del cliente para audit. Fallback NULL si falla (no bloquea el flow).
export async function getIpCliente(): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json() as { ip?: string };
    return j.ip ?? null;
  } catch { return null; }
}
