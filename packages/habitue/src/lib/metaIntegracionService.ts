// metaIntegracionService — config del Meta Pixel + Conversions API por cliente.
// Tabla marketing_integraciones (migración 202607281400). El token CAPI es
// secreto (no se lee por SELECT — sólo service_role). Se guarda vía RPC
// fn_upsert_marketing_meta (valida dueño/admin). Graceful si falta la tabla.

import { db } from './supabase';

export interface MetaIntegracion {
  meta_pixel_id: string | null;
  meta_test_event_code: string | null;
  meta_activa: boolean;
}

function faltaTabla(msg: string): boolean {
  return /marketing_integraciones/.test(msg) && /(does not exist|could not find the table)/i.test(msg);
}

export async function getMetaIntegracion(): Promise<{ data: MetaIntegracion | null; error: string | null; sinTabla?: boolean }> {
  const { data, error } = await db()
    .from('marketing_integraciones')
    .select('meta_pixel_id, meta_test_event_code, meta_activa')
    .maybeSingle();
  if (error) {
    if (faltaTabla(error.message)) return { data: null, error: null, sinTabla: true };
    return { data: null, error: error.message };
  }
  if (!data) return { data: null, error: null };
  return {
    data: {
      meta_pixel_id: (data.meta_pixel_id as string | null) ?? null,
      meta_test_event_code: (data.meta_test_event_code as string | null) ?? null,
      meta_activa: Boolean(data.meta_activa),
    },
    error: null,
  };
}

// Guarda la config. Si capiToken viene vacío, el server conserva el token actual
// (permite editar el Pixel ID sin re-tipear el token).
export async function upsertMetaIntegracion(args: {
  pixelId: string;
  capiToken: string;
  testEventCode: string;
  activa: boolean;
}): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await db().rpc('fn_upsert_marketing_meta', {
    p_pixel_id: args.pixelId,
    p_capi_token: args.capiToken,
    p_test_event_code: args.testEventCode,
    p_activa: args.activa,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}
