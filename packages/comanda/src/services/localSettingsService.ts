import { db } from '../lib/supabase';
import type { ComandaLocalSettings, PosModo } from '../types/database';

const MP_QR_BUCKET = 'mp-qrs';

export async function getLocalSettings(localId: number): Promise<{ data: ComandaLocalSettings | null; error: string | null }> {
  const { data, error } = await db
    .from('comanda_local_settings')
    .select('*')
    .eq('local_id', localId)
    .is('deleted_at', null)
    .limit(1);
  if (error) return { data: null, error: error.message };
  return { data: (data?.[0] as ComandaLocalSettings | undefined) ?? null, error: null };
}

export type LocalSettingsPatch = Partial<Pick<
  ComandaLocalSettings,
  | 'slug' | 'direccion' | 'telefono' | 'instagram' | 'web' | 'mp_qr_url'
  | 'costo_envio_default' | 'tiempo_retiro_min' | 'tiempo_delivery_min'
  | 'tienda_activa' | 'acepta_delivery' | 'autolock_minutos' | 'features_pos_modos'
>>;

export async function updateLocalSettings(
  id: number,
  patch: LocalSettingsPatch,
): Promise<{ error: string | null }> {
  const { error } = await db.from('comanda_local_settings').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}

// Validar slug único para tienda online
export async function validarSlugUnico(slug: string, excluyeLocalId: number): Promise<{ disponible: boolean; error: string | null }> {
  const { data, error } = await db
    .from('comanda_local_settings')
    .select('id, local_id')
    .eq('slug', slug)
    .is('deleted_at', null);
  if (error) return { disponible: false, error: error.message };
  const conflict = (data ?? []).find((r) => (r as { local_id: number }).local_id !== excluyeLocalId);
  return { disponible: !conflict, error: null };
}

// Subir QR de MP a Supabase Storage. Path: <tenant_id>/<local_id>.<ext>
export async function subirMpQr(
  tenantId: string,
  localId: number,
  file: File,
): Promise<{ url: string | null; error: string | null }> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
    return { url: null, error: 'Formato debe ser PNG/JPG/WEBP' };
  }
  const path = `${tenantId}/${localId}.${ext}`;
  const { error: upErr } = await db.storage.from(MP_QR_BUCKET).upload(path, file, {
    upsert: true,
    contentType: file.type,
  });
  if (upErr) return { url: null, error: upErr.message };

  const { data: pub } = db.storage.from(MP_QR_BUCKET).getPublicUrl(path);
  return { url: pub.publicUrl, error: null };
}

export async function eliminarMpQr(
  tenantId: string,
  localId: number,
): Promise<{ error: string | null }> {
  // Probar las extensiones comunes; ignorar 404
  const exts = ['png', 'jpg', 'jpeg', 'webp'];
  for (const ext of exts) {
    await db.storage.from(MP_QR_BUCKET).remove([`${tenantId}/${localId}.${ext}`]).catch(() => null);
  }
  return { error: null };
}

export type FeaturesPatch = { features_pos_modos: PosModo[] };

export async function setFeaturesPosModos(
  id: number,
  modos: PosModo[],
): Promise<{ error: string | null }> {
  if (modos.length === 0) return { error: 'Tenés que habilitar al menos un modo POS' };
  const { error } = await db.from('comanda_local_settings')
    .update({ features_pos_modos: modos } satisfies FeaturesPatch)
    .eq('id', id);
  return { error: error?.message ?? null };
}
