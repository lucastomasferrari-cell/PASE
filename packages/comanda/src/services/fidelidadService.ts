// packages/comanda/src/services/fidelidadService.ts
// Servicios para programa de fidelidad (puntos + niveles).
// Brainstorm #8 Fase 5 Chunk A — 2026-06-01.
//
// 2 RPCs públicas (anon-callable, identificación por teléfono):
//   - consultarPuntosPublico: cliente ve saldo + nivel + equivalencia $
//   - canjearPuntosPublico: aplica canje contra venta pre-cobro
//
// Patrón: errores devueltos como string traducido (no Error throws),
// igual que cuponesService.ts. Las pantallas hacen if (error) toast.error.

import { db } from '@/lib/supabase';

export interface PuntosInfo {
  puntos_disponibles: number;
  nivel: 'bronze' | 'silver' | 'gold' | 'platinum';
  pesos_por_punto: number;
  fidelidad_activa: boolean;
}

const NIVEL_LABEL: Record<PuntosInfo['nivel'], string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
};

export function labelNivel(nivel: PuntosInfo['nivel']): string {
  return NIVEL_LABEL[nivel];
}

export function colorNivel(nivel: PuntosInfo['nivel']): string {
  // Tailwind-ish colors
  switch (nivel) {
    case 'gold':     return '#d97706'; // amber-600
    case 'silver':   return '#94a3b8'; // slate-400
    case 'platinum': return '#06b6d4'; // cyan-500
    default:         return '#a16207'; // amber-700 (bronze)
  }
}

/**
 * Consulta puntos + nivel del cliente identificado por teléfono.
 * Si el cliente no existe, devuelve ceros sin error (UI muestra "sin puntos").
 * Si fidelidad no activa en el local, devuelve fidelidad_activa=false.
 */
export async function consultarPuntosPublico(
  slug: string,
  telefono: string,
): Promise<{ data: PuntosInfo | null; error: string | null }> {
  if (!telefono.trim()) return { data: null, error: null };
  const { data, error } = await db.rpc('fn_consultar_puntos_publico', {
    p_slug: slug,
    p_telefono: telefono.trim(),
  });
  if (error) {
    return { data: null, error: error.message };
  }
  // RPC retorna TABLE → array
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { data: null, error: null };
  return {
    data: {
      puntos_disponibles: Number(row.puntos_disponibles ?? 0),
      nivel: (row.nivel as PuntosInfo['nivel']) || 'bronze',
      pesos_por_punto: Number(row.pesos_por_punto ?? 5),
      fidelidad_activa: !!row.fidelidad_activa,
    },
    error: null,
  };
}

/**
 * Canjea N puntos del cliente contra una venta ya creada (pre-cobro).
 * Idempotent: si se llama 2 veces con misma venta_id/cliente, retorna
 * el descuento ya aplicado sin duplicar.
 * Retorna el monto $ del descuento aplicado.
 */
export async function canjearPuntosPublico(args: {
  slug: string;
  telefono: string;
  ventaId: number;
  puntos: number;
}): Promise<{ descuento: number; error: string | null }> {
  const { data, error } = await db.rpc('fn_canjear_puntos_publico', {
    p_slug: args.slug,
    p_telefono: args.telefono.trim(),
    p_venta_id: args.ventaId,
    p_puntos: args.puntos,
  });
  if (error) return { descuento: 0, error: error.message };
  return { descuento: Number(data ?? 0), error: null };
}
