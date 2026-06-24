import { db } from '../lib/supabase';
import type { ComandaLocalSettings, HorarioReserva, PosModo } from '../types/database';
import { translateError } from '../lib/errors';
import { compressImage } from '../lib/compressImage';

const MP_QR_BUCKET = 'mp-qrs';
const MARKETPLACE_BUCKET = 'marketplace-fotos';

export async function getLocalSettings(localId: number): Promise<{ data: ComandaLocalSettings | null; error: string | null }> {
  const { data, error } = await db
    .from('comanda_local_settings')
    .select('*')
    .eq('local_id', localId)
    .is('deleted_at', null)
    .limit(1);
  if (error) return { data: null, error: translateError(error) };
  return { data: (data?.[0] as ComandaLocalSettings | undefined) ?? null, error: null };
}

// Patch para comanda_local_settings. Los campos de horario_xxx son strings
// "HH:MM-HH:MM[,HH:MM-HH:MM]" — el marketplace los usa para badge "Abierto ahora".
export interface LocalSettingsPatch {
  slug?: string;
  direccion?: string | null;
  telefono?: string | null;
  instagram?: string | null;
  web?: string | null;
  mp_qr_url?: string | null;
  costo_envio_default?: number;
  tiempo_retiro_min?: number;
  tiempo_delivery_min?: number;
  tienda_activa?: boolean;
  acepta_delivery?: boolean;
  autolock_minutos?: number;
  features_pos_modos?: PosModo[];
  horario_lun?: string | null;
  horario_mar?: string | null;
  horario_mie?: string | null;
  horario_jue?: string | null;
  horario_vie?: string | null;
  horario_sab?: string | null;
  horario_dom?: string | null;
  // MESA módulo #3 — config reservas
  reservas_activas?: boolean;
  reservas_capacidad_max?: number | null;
  reservas_anticipacion_min_hs?: number;
  reservas_anticipacion_max_dias?: number;
  reservas_duracion_estimada_min?: number;
  reservas_horarios?: HorarioReserva[];
  reservas_telefono_obligatorio?: boolean;
  reservas_requiere_confirmacion?: boolean;
  reservas_notas_visibles_cliente?: string | null;
}

export async function updateLocalSettings(
  id: number,
  patch: LocalSettingsPatch,
): Promise<{ error: string | null }> {
  const { error } = await db.from('comanda_local_settings').update(patch).eq('id', id);
  return { error: error?.message ?? null };
}

export async function getLocalNombre(localId: number): Promise<string | null> {
  const { data } = await db.from('locales').select('nombre').eq('id', localId).single();
  return (data as { nombre: string } | null)?.nombre ?? null;
}

// Validar slug único para tienda online
export async function validarSlugUnico(slug: string, excluyeLocalId: number): Promise<{ disponible: boolean; error: string | null }> {
  const { data, error } = await db
    .from('comanda_local_settings')
    .select('id, local_id')
    .eq('slug', slug)
    .is('deleted_at', null);
  if (error) return { disponible: false, error: translateError(error) };
  const conflict = (data ?? []).find((r) => (r as { local_id: number }).local_id !== excluyeLocalId);
  return { disponible: !conflict, error: null };
}

// Subir QR de MP a Supabase Storage. Path: <tenant_id>/<local_id>.<ext>
// QR es típicamente PNG con transparencia — compressImage detecta alpha
// y NO toca PNG con alpha. Para PNG sin alpha o JPG, baja a ~80KB.
export async function subirMpQr(
  tenantId: string,
  localId: number,
  file: File,
): Promise<{ url: string | null; error: string | null }> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'png';
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
    return { url: null, error: 'Formato debe ser PNG/JPG/WEBP' };
  }
  // Compresión client-side (sprint optim egress 2026-05-16)
  const compressed = await compressImage(file, { maxWidth: 600, quality: 0.85 });
  const finalExt = compressed.type === 'image/jpeg' ? 'jpg' : ext;
  const path = `${tenantId}/${localId}.${finalExt}`;
  const { error: upErr } = await db.storage.from(MP_QR_BUCKET).upload(path, compressed, {
    upsert: true,
    contentType: compressed.type,
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

// ─── Marketplace: campos viven en `locales`, no en comanda_local_settings ────

export interface MarketplaceLocal {
  id: number;
  nombre: string;
  visible_marketplace: boolean;
  marketplace_descripcion: string | null;
  marketplace_tags: string[] | null;
  marketplace_foto_url: string | null;
  provincia?: string | null;
  localidad?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** Radio máximo de entrega en km. NULL = sin límite. Validado en checkout. */
  radio_delivery_km?: number | null;
}

export async function getMarketplaceLocal(localId: number): Promise<{ data: MarketplaceLocal | null; error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- query directa por PK del local activo, sin riesgo cross-local
  const { data, error } = await db
    .from('locales')
    .select('id, nombre, visible_marketplace, marketplace_descripcion, marketplace_tags, marketplace_foto_url, provincia, localidad, lat, lon, radio_delivery_km')
    .eq('id', localId)
    .single();
  if (error) return { data: null, error: translateError(error) };
  return { data: data as MarketplaceLocal, error: null };
}

export interface MarketplacePatch {
  visible_marketplace?: boolean;
  marketplace_descripcion?: string | null;
  marketplace_tags?: string[] | null;
  marketplace_foto_url?: string | null;
  provincia?: string | null;
  localidad?: string | null;
  lat?: number | null;
  lon?: number | null;
  radio_delivery_km?: number | null;
}

export async function updateMarketplaceLocal(
  localId: number,
  patch: MarketplacePatch,
): Promise<{ error: string | null }> {
  // eslint-disable-next-line pase-local/require-apply-local-scope -- update directo por PK del local activo
  const { error } = await db.from('locales').update(patch).eq('id', localId);
  return { error: error?.message ?? null };
}

// Sprint 16/05: upload foto portada marketplace al bucket "marketplace-fotos"
// (público). Compresión client-side antes de subir (sprint optim egress
// 2026-05-16) → reduce foto del celular típica 800KB-3MB a ~150-250KB.
// Egress baja 5-10x cada vez que un cliente ve el marketplace.
export async function subirMarketplaceFoto(
  tenantId: string,
  localId: number,
  file: File,
): Promise<{ url: string | null; error: string | null }> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
    return { url: null, error: 'Formato debe ser PNG/JPG/WEBP' };
  }
  if (file.size > 10 * 1024 * 1024) {
    return { url: null, error: 'Imagen muy grande (máx 10MB sin comprimir)' };
  }
  // Compresión client-side: max 1200px ancho, JPEG 80% quality
  const compressed = await compressImage(file, { maxWidth: 1200, quality: 0.8 });
  const finalExt = compressed.type === 'image/jpeg' ? 'jpg' : ext;
  const path = `${tenantId}/${localId}-${Date.now()}.${finalExt}`;  // timestamp evita cache CDN
  const { error: upErr } = await db.storage.from(MARKETPLACE_BUCKET).upload(path, compressed, {
    upsert: true,
    contentType: compressed.type,
  });
  if (upErr) {
    if (upErr.message.includes('Bucket not found')) {
      return { url: null, error: 'Bucket marketplace-fotos no existe. Creálo en Supabase Storage (público).' };
    }
    return { url: null, error: upErr.message };
  }
  const { data: pub } = db.storage.from(MARKETPLACE_BUCKET).getPublicUrl(path);
  return { url: pub.publicUrl, error: null };
}
