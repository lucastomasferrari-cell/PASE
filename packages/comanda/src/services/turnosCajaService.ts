import { db } from '../lib/supabase';
import type { TurnoCaja, MovimientoCaja } from '../types/database';
import { translateError } from '../lib/errors';

export async function getTurnoAbierto(localId: number): Promise<{ data: TurnoCaja | null; error: string | null }> {
  const { data, error } = await db
    .from('turnos_caja')
    .select('*')
    .eq('local_id', localId)
    .eq('estado', 'abierto')
    .limit(1);
  if (error) return { data: null, error: translateError(error) };
  return { data: (data?.[0] as TurnoCaja | undefined) ?? null, error: null };
}

export async function abrirTurno(
  localId: number,
  cajeroId: string,
  montoInicial: number,
  notas: string | null,
  idempotencyKey?: string,
): Promise<{ turnoId: number | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_abrir_turno_caja_comanda', {
    p_local_id: localId,
    p_cajero_id: cajeroId,
    p_monto_inicial: montoInicial,
    p_notas: notas,
    p_idempotency_key: idempotencyKey ?? null,
  });
  if (error) return { turnoId: null, error: translateError(error) };
  return { turnoId: data as number, error: null };
}

export async function cerrarTurno(
  turnoId: number,
  cerradoPor: string,
  montoFinalDeclarado: number,
  notas: string | null,
  efectivoBreakdown?: { billetes: Record<string, number>; monedas: Record<string, number>; total: number } | null,
  idempotencyKey?: string,
): Promise<{ data: { calculado: number; diferencia: number } | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_cerrar_turno_caja_comanda', {
    p_turno_id: turnoId,
    p_cerrado_por: cerradoPor,
    p_monto_final_declarado: montoFinalDeclarado,
    p_notas: notas,
    p_idempotency_key: idempotencyKey ?? null,
    p_efectivo_breakdown: efectivoBreakdown ?? null,
  });
  if (error) return { data: null, error: translateError(error) };
  const arr = data as Array<{ monto_calculado: number; diferencia: number }> | null;
  const row = arr?.[0];
  if (!row) return { data: { calculado: 0, diferencia: 0 }, error: null };
  return { data: { calculado: Number(row.monto_calculado), diferencia: Number(row.diferencia) }, error: null };
}

export async function listMovimientos(turnoId: number): Promise<{ data: MovimientoCaja[]; error: string | null }> {
  const { data, error } = await db
    .from('movimientos_caja')
    .select('*')
    .eq('turno_caja_id', turnoId)
    .order('created_at', { ascending: false });
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as MovimientoCaja[], error: null };
}

export async function registrarMovimiento(
  localId: number,
  empleadoId: string,
  tipo: 'retiro' | 'deposito' | 'ajuste',
  monto: number,
  metodo: string,
  motivo: string,
  idempotencyKey?: string,
  managerId?: string | null,
): Promise<{ id: number | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_movimiento_caja_comanda', {
    p_local_id: localId,
    p_empleado_id: empleadoId,
    p_tipo: tipo,
    p_monto: monto,
    p_metodo: metodo,
    p_motivo: motivo,
    p_idempotency_key: idempotencyKey ?? null,
    p_manager_id: managerId ?? null,
  });
  if (error) return { id: null, error: translateError(error) };
  return { id: data as number, error: null };
}

// Totales por método del turno (para CajaEstado y CajaCerrar)
export interface TotalesPorMetodo {
  metodo: string;
  total: number;
  cantidad: number;
}

export async function totalesPorMetodo(turnoId: number): Promise<{ data: TotalesPorMetodo[]; error: string | null }> {
  const { data, error } = await db
    .from('movimientos_caja')
    .select('metodo, monto, tipo')
    .eq('turno_caja_id', turnoId);
  if (error) return { data: [], error: translateError(error) };
  const map = new Map<string, { total: number; cantidad: number }>();
  for (const row of data ?? []) {
    const r = row as { metodo: string; monto: number; tipo: string };
    if (r.tipo === 'cierre') continue;
    const cur = map.get(r.metodo) ?? { total: 0, cantidad: 0 };
    const signo = r.tipo === 'retiro' || r.tipo === 'venta_anulada' ? -1 : 1;
    cur.total += signo * Number(r.monto);
    cur.cantidad += 1;
    map.set(r.metodo, cur);
  }
  const out: TotalesPorMetodo[] = Array.from(map.entries()).map(([metodo, v]) => ({
    metodo, total: v.total, cantidad: v.cantidad,
  }));
  return { data: out, error: null };
}

// ─── Sprint 4: histórico de turnos ────────────────────────────────────────

export async function listHistoricoTurnos(localId: number, limit = 50): Promise<{ data: TurnoCaja[]; error: string | null }> {
  const { data, error } = await db
    .from('turnos_caja')
    .select('*')
    .eq('local_id', localId)
    .eq('estado', 'cerrado')
    .order('numero', { ascending: false })
    .limit(limit);
  if (error) return { data: [], error: translateError(error) };
  return { data: (data ?? []) as TurnoCaja[], error: null };
}
