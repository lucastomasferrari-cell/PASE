// pautaService — registro de inversión publicitaria (Meta/Google/IG). Tabla
// marketing_inversiones (migración 202606250500). Graceful si no está aplicada.

import { db } from './supabase';

export interface Inversion {
  id: number;
  fecha: string;
  plataforma: string;
  campania: string | null;
  monto: number;
  alcance: number | null;
  clicks: number | null;
  notas: string | null;
}

export interface InversionInput {
  fecha: string;
  plataforma: string;
  campania?: string;
  monto: number;
  alcance?: number;
  clicks?: number;
  notas?: string;
}

function faltaTabla(msg: string) {
  return /relation .*marketing_inversiones.* does not exist/i.test(msg) || /could not find the table/i.test(msg);
}

export async function listInversiones(): Promise<{ data: Inversion[]; error: string | null; sinTabla?: boolean }> {
  const { data, error } = await db()
    .from('marketing_inversiones')
    .select('id, fecha, plataforma, campania, monto, alcance, clicks, notas')
    .is('deleted_at', null)
    .order('fecha', { ascending: false })
    .limit(500);
  if (error) {
    if (faltaTabla(error.message)) return { data: [], error: null, sinTabla: true };
    return { data: [], error: error.message };
  }
  return { data: (data ?? []) as Inversion[], error: null };
}

export async function crearInversion(tenantId: string, input: InversionInput): Promise<{ error: string | null }> {
  const { error } = await db().from('marketing_inversiones').insert({
    tenant_id: tenantId,
    local_id: null,
    fecha: input.fecha,
    plataforma: input.plataforma,
    campania: input.campania?.trim() || null,
    monto: input.monto,
    alcance: input.alcance ?? null,
    clicks: input.clicks ?? null,
    notas: input.notas?.trim() || null,
  });
  if (error && faltaTabla(error.message)) {
    return { error: 'La pauta necesita una actualización de la base (migración 202606250500 pendiente).' };
  }
  return { error: error?.message ?? null };
}

export async function eliminarInversion(id: number): Promise<{ error: string | null }> {
  const { error } = await db().from('marketing_inversiones').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}
