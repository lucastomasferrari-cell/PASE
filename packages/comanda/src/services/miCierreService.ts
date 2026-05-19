import { db } from '@/lib/supabase';

// Service para fn_mi_cierre_mozo — devuelve el shift report del mozo
// para el período (default hoy). Auth check server-side: el caller debe
// ser el mozo o dueño/admin.

export interface CierreMozo {
  ventas_cobradas: number;
  total_cobrado: number;
  efectivo: number;
  credito: number;
  credito_cuotas: number;
  debito: number;
  qr: number;
  transferencia: number;
  otros: number;
  primer_cobro: string | null;
  ultimo_cobro: string | null;
  mesas_atendidas: number;
  ticket_promedio: number;
}

export async function getMiCierre(
  empleadoId: string,
  desde?: Date,
  hasta?: Date,
): Promise<{ data: CierreMozo | null; error: string | null }> {
  const { data, error } = await db.rpc('fn_mi_cierre_mozo', {
    p_empleado_id: empleadoId,
    p_fecha_desde: desde ? desde.toISOString() : null,
    p_fecha_hasta: hasta ? hasta.toISOString() : null,
  });
  if (error) return { data: null, error: error.message };
  if (!data) return { data: null, error: null };
  // RPC RETURNS TABLE — viene como array
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { data: null, error: null };
  return {
    data: {
      ventas_cobradas: Number(row.ventas_cobradas ?? 0),
      total_cobrado: Number(row.total_cobrado ?? 0),
      efectivo: Number(row.efectivo ?? 0),
      credito: Number(row.credito ?? 0),
      credito_cuotas: Number(row.credito_cuotas ?? 0),
      debito: Number(row.debito ?? 0),
      qr: Number(row.qr ?? 0),
      transferencia: Number(row.transferencia ?? 0),
      otros: Number(row.otros ?? 0),
      primer_cobro: row.primer_cobro,
      ultimo_cobro: row.ultimo_cobro,
      mesas_atendidas: Number(row.mesas_atendidas ?? 0),
      ticket_promedio: Number(row.ticket_promedio ?? 0),
    },
    error: null,
  };
}
