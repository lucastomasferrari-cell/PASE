// fidelidadService — administra el programa de puntos (ya existe en la base:
// config por local en comanda_local_settings + clientes.puntos_disponibles +
// ledger cliente_puntos_movimientos; acumula al cobrar en COMANDA y se canjea
// en la tienda). Habitué administra la config y ve el ranking de puntos.

import { db } from './supabase';

export interface FidelidadConfig {
  settings_id: number;
  local_id: number;
  nombre: string;
  activa: boolean;
  puntos_por_peso: number;   // ej 0.01 = 1pt cada $100
  pesos_por_punto: number;   // ej 5 = 1pt vale $5
}

export async function listConfigFidelidad(): Promise<{ data: FidelidadConfig[]; error: string | null }> {
  const { data, error } = await db()
    .from('comanda_local_settings')
    .select('id, local_id, fidelidad_activa, fidelidad_puntos_por_peso, fidelidad_pesos_por_punto, locales(nombre)')
    .is('deleted_at', null)
    .order('local_id');
  if (error) return { data: [], error: error.message };
  const rows = (data ?? []).map((r) => {
    const row = r as unknown as {
      id: number; local_id: number; fidelidad_activa: boolean | null;
      fidelidad_puntos_por_peso: number | null; fidelidad_pesos_por_punto: number | null;
      locales: { nombre: string } | null;
    };
    return {
      settings_id: row.id, local_id: row.local_id,
      nombre: row.locales?.nombre ?? `Local ${row.local_id}`,
      activa: !!row.fidelidad_activa,
      puntos_por_peso: Number(row.fidelidad_puntos_por_peso ?? 0.01),
      pesos_por_punto: Number(row.fidelidad_pesos_por_punto ?? 5),
    } satisfies FidelidadConfig;
  });
  return { data: rows, error: null };
}

export async function updateFidelidad(
  settingsId: number,
  patch: { activa?: boolean; puntos_por_peso?: number; pesos_por_punto?: number },
): Promise<{ error: string | null }> {
  const upd: Record<string, unknown> = {};
  if (patch.activa !== undefined) upd.fidelidad_activa = patch.activa;
  if (patch.puntos_por_peso !== undefined) upd.fidelidad_puntos_por_peso = patch.puntos_por_peso;
  if (patch.pesos_por_punto !== undefined) upd.fidelidad_pesos_por_punto = patch.pesos_por_punto;
  const { error } = await db().from('comanda_local_settings').update(upd).eq('id', settingsId);
  return { error: error?.message ?? null };
}

export interface ClientePuntos {
  id: number;
  nombre: string | null;
  apellido: string | null;
  telefono: string | null;
  puntos_disponibles: number;
}

export async function listTopPuntos(limit = 50): Promise<{ data: ClientePuntos[]; error: string | null }> {
  const { data, error } = await db()
    .from('clientes')
    .select('id, nombre, apellido, telefono, puntos_disponibles')
    .is('deleted_at', null)
    .gt('puntos_disponibles', 0)
    .order('puntos_disponibles', { ascending: false })
    .limit(limit);
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as ClientePuntos[], error: null };
}
