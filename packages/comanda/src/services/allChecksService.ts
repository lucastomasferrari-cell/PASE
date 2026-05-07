import { db } from '../lib/supabase';
import type { VentaPos, ModoVenta, EstadoVenta } from '../types/database';

export type PeriodoFiltro = 'hoy' | 'ayer' | 'semana' | 'mes' | 'trimestre' | 'custom';

function getPeriodoRange(periodo: PeriodoFiltro, customDesde?: Date, customHasta?: Date): { desde: Date; hasta: Date } {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  if (periodo === 'hoy') return { desde: startOfDay(now), hasta: endOfDay(now) };
  if (periodo === 'ayer') {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    return { desde: startOfDay(y), hasta: endOfDay(y) };
  }
  if (periodo === 'semana') {
    const w = new Date(now); w.setDate(w.getDate() - 7);
    return { desde: startOfDay(w), hasta: endOfDay(now) };
  }
  if (periodo === 'mes') {
    const m = new Date(now); m.setDate(m.getDate() - 30);
    return { desde: startOfDay(m), hasta: endOfDay(now) };
  }
  if (periodo === 'trimestre') {
    const q = new Date(now); q.setDate(q.getDate() - 90);
    return { desde: startOfDay(q), hasta: endOfDay(now) };
  }
  return {
    desde: customDesde ?? startOfDay(now),
    hasta: customHasta ?? endOfDay(now),
  };
}

export interface AllChecksFilter {
  localId: number;
  query?: string;
  modo?: ModoVenta | 'todos';
  estado?: EstadoVenta | 'cualquiera';
  periodo: PeriodoFiltro;
  customDesde?: Date;
  customHasta?: Date;
  sort?: 'recientes' | 'antiguas' | 'mayor' | 'menor';
}

export async function buscarChecks(filter: AllChecksFilter): Promise<{ data: VentaPos[]; error: string | null }> {
  const { desde, hasta } = getPeriodoRange(filter.periodo, filter.customDesde, filter.customHasta);
  let q = db
    .from('ventas_pos')
    .select('*')
    .eq('local_id', filter.localId)
    .gte('created_at', desde.toISOString())
    .lte('created_at', hasta.toISOString())
    .is('deleted_at', null);

  if (filter.modo && filter.modo !== 'todos') q = q.eq('modo', filter.modo);
  if (filter.estado && filter.estado !== 'cualquiera') q = q.eq('estado', filter.estado);
  if (filter.query?.trim()) {
    const t = filter.query.trim();
    const num = Number(t);
    if (Number.isFinite(num)) {
      q = q.eq('numero_local', num);
    } else {
      q = q.or(`cliente_nombre.ilike.%${t}%,cliente_telefono.ilike.%${t}%`);
    }
  }

  switch (filter.sort) {
    case 'antiguas': q = q.order('created_at', { ascending: true }); break;
    case 'mayor':    q = q.order('total', { ascending: false }); break;
    case 'menor':    q = q.order('total', { ascending: true }); break;
    default:         q = q.order('created_at', { ascending: false });
  }
  q = q.limit(500);

  const { data, error } = await q;
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as VentaPos[], error: null };
}

export function sumaChecks(ventas: VentaPos[]): number {
  return ventas.reduce((acc, v) => acc + Number(v.total ?? 0), 0);
}
