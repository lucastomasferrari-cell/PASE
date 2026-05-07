import { db } from '../lib/supabase';

export type DescuentoTipo = 'porcentaje' | 'monto';

// Umbral arriba del cual hace falta manager override (per brief PARTE 4.1.5).
const UMBRAL_PCT = 15;
const UMBRAL_RATIO = 0.20;

export function requiereOverride(tipo: DescuentoTipo, valor: number, total: number): boolean {
  if (tipo === 'porcentaje') return valor > UMBRAL_PCT;
  if (tipo === 'monto') return valor > total * UMBRAL_RATIO;
  return false;
}

export function calcularMontoDescuento(tipo: DescuentoTipo, valor: number, subtotal: number): number {
  if (tipo === 'porcentaje') {
    if (valor < 0 || valor > 100) return 0;
    return Math.round(subtotal * (valor / 100) * 100) / 100;
  }
  return Math.max(0, valor);
}

export interface AplicarDescuentoArgs {
  ventaId: number;
  tipo: DescuentoTipo;
  valor: number;
  motivo: string;
  managerId?: string | null;
  idempotencyKey?: string;
}

// Reusa fn_aplicar_descuento_comanda del Sprint 2 (recibe monto YA calculado).
// El cliente decide si requiere override, y si sí, pasa managerId.
// Sprint 7: idempotencyKey opcional previene doble-aplicación por doble-click.
export async function aplicarDescuento(
  args: AplicarDescuentoArgs,
  subtotal: number,
): Promise<{ error: string | null }> {
  const monto = calcularMontoDescuento(args.tipo, args.valor, subtotal);
  if (monto <= 0) return { error: 'Monto de descuento inválido' };

  const { error } = await db.rpc('fn_aplicar_descuento_comanda', {
    p_venta_id: args.ventaId,
    p_monto: monto,
    p_motivo: args.motivo,
    p_manager_id: args.managerId ?? null,
    p_idempotency_key: args.idempotencyKey ?? null,
  });
  return { error: error?.message ?? null };
}
