// Subida de fotos del local al bucket público `marketplace-fotos`.
// Lo usa el editor del perfil (AdminPerfil) para que el dueño suba fotos
// directo desde su compu en vez de pegar URLs a mano.
//
// El bucket es público pero las RLS de escritura exigen que el path arranque
// con la carpeta del tenant: `<tenant_id>/...`. Por eso el path SIEMPRE es
// `${tenantId}/local-${localId}-${timestamp}-${rand}.<ext>`.
//
// Comprime client-side con canvas (sin libs externas) para bajar egress:
// una foto de celular de 2-4MB queda en ~150-400KB manteniendo calidad OK
// para el hero y las cards de la página pública.

import { db } from '@/lib/supabase';

const EXTENSIONES_OK = ['jpg', 'jpeg', 'png', 'webp'];
const MAX_LADO = 1600; // px del lado más largo tras redimensionar
const CALIDAD_WEBP = 0.82;
const MAX_BYTES = 4 * 1024 * 1024; // ~4MB tras comprimir

export async function subirFotoLocal(
  file: File,
  tenantId: string,
  localId: number,
): Promise<{ url: string | null; error: string | null }> {
  const extOriginal = file.name.split('.').pop()?.toLowerCase() || '';
  if (!EXTENSIONES_OK.includes(extOriginal)) {
    return { url: null, error: 'Solo aceptamos imágenes JPG, PNG o WEBP.' };
  }

  // Comprimir a webp; si algo falla, seguimos con el archivo original.
  const comprimido = await comprimirImagen(file);
  const blob: Blob = comprimido ?? file;
  const ext = comprimido ? 'webp' : extOriginal;
  const contentType = comprimido ? 'image/webp' : file.type || `image/${ext}`;

  if (blob.size > MAX_BYTES) {
    return { url: null, error: 'La foto pesa demasiado. Bajá la resolución o usá otra.' };
  }

  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${tenantId}/local-${localId}-${Date.now()}-${rand}.${ext}`;

  const { error: uploadError } = await db()
    .storage.from('marketplace-fotos')
    .upload(path, blob, { contentType, upsert: false });
  if (uploadError) return { url: null, error: uploadError.message };

  const { data: pub } = db().storage.from('marketplace-fotos').getPublicUrl(path);
  return { url: pub.publicUrl, error: null };
}

// Redimensiona con canvas al lado más largo <= MAX_LADO y exporta webp.
// Devuelve null si el navegador no soporta canvas/toBlob o si algo revienta,
// para que el llamador use el archivo original como fallback.
async function comprimirImagen(file: File): Promise<Blob | null> {
  try {
    const img = await cargarImagen(file);
    const ladoMayor = Math.max(img.width, img.height);
    const ratio = ladoMayor > MAX_LADO ? MAX_LADO / ladoMayor : 1;
    const targetW = Math.round(img.width * ratio);
    const targetH = Math.round(img.height * ratio);

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, targetW, targetH);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/webp', CALIDAD_WEBP);
    });
    return blob;
  } catch {
    return null;
  }
}

function cargarImagen(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}
