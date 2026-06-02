// Service para reviews del marketplace.
//
// Reviews públicas: cualquier cliente que terminó un pedido en tienda online
// puede dejar 1 review (rating 1-5 + comentario opcional). Anti-abuso:
// el teléfono debe coincidir con el de la venta.
//
// Para mostrar: fn_listar_reviews_publicas devuelve hasta 50 reviews + el
// resumen (avg + count). Lo usa la pantalla pública /tienda/:slug y
// el marketplace al enriquecer las cards.

import { dbAnon } from '@/lib/supabaseAnon';
import { translateError } from '@/lib/errors';

export interface Review {
  review_id: string;
  autor_nombre: string;
  rating: number;
  comentario: string | null;
  created_at: string;
  // Brainstorm #8 F5 Chunk C (2026-06-01) — multi-aspecto + foto
  estrellas_comida?: number | null;
  estrellas_entrega?: number | null;
  estrellas_presentacion?: number | null;
  foto_url?: string | null;
}

export interface ReviewsResumen {
  total_reviews: number;
  rating_promedio: number | null;
  reviews: Review[];
}

export async function listarReviewsPublicas(localSlug: string): Promise<{ data: ReviewsResumen; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_listar_reviews_publicas', { p_local_slug: localSlug });
  if (error) {
    return { data: { total_reviews: 0, rating_promedio: null, reviews: [] }, error: translateError(error) };
  }
  const rows = (data as Array<{
    review_id: string;
    autor_nombre: string;
    rating: number;
    comentario: string | null;
    created_at: string;
    total_reviews: number;
    rating_promedio: number;
  }>) ?? [];
  if (rows.length === 0) {
    return { data: { total_reviews: 0, rating_promedio: null, reviews: [] }, error: null };
  }
  // Todos los rows traen el mismo total + promedio (resultado del agregado).
  const first = rows[0]!;
  return {
    data: {
      total_reviews: Number(first.total_reviews),
      rating_promedio: first.rating_promedio == null ? null : Number(first.rating_promedio),
      reviews: rows.map((r) => ({
        review_id: r.review_id,
        autor_nombre: r.autor_nombre,
        rating: r.rating,
        comentario: r.comentario,
        created_at: r.created_at,
        estrellas_comida: (r as Review).estrellas_comida ?? null,
        estrellas_entrega: (r as Review).estrellas_entrega ?? null,
        estrellas_presentacion: (r as Review).estrellas_presentacion ?? null,
        foto_url: (r as Review).foto_url ?? null,
      })),
    },
    error: null,
  };
}

export interface CrearReviewArgs {
  ventaId: number;
  telefono: string;
  rating: number;       // 1-5 (global, obligatorio)
  comentario?: string | null;
  email?: string | null;
  // Brainstorm #8 F5 Chunk C (2026-06-01) — opcionales
  estrellasComida?: number | null;
  estrellasEntrega?: number | null;
  estrellasPresentacion?: number | null;
  fotoUrl?: string | null;
}

export async function crearReviewPublica(args: CrearReviewArgs): Promise<{ reviewId: string | null; yaExistia: boolean; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_crear_review_publica', {
    p_venta_id: args.ventaId,
    p_telefono: args.telefono,
    p_rating: args.rating,
    p_comentario: args.comentario ?? null,
    p_email: args.email ?? null,
    p_estrellas_comida: args.estrellasComida ?? null,
    p_estrellas_entrega: args.estrellasEntrega ?? null,
    p_estrellas_presentacion: args.estrellasPresentacion ?? null,
    p_foto_url: args.fotoUrl ?? null,
  });
  if (error) return { reviewId: null, yaExistia: false, error: translateError(error) };
  const obj = data as { review_id: string; ya_existia: boolean };
  return { reviewId: obj.review_id, yaExistia: !!obj.ya_existia, error: null };
}

/**
 * Sube una foto al bucket marketplace_review_photos y retorna la URL pública.
 * Path: tenant/local-ventaId-timestamp.ext para evitar colisiones.
 */
export async function subirFotoReview(
  file: File,
  ventaId: number,
): Promise<{ url: string | null; error: string | null }> {
  if (file.size > 2 * 1024 * 1024) {
    return { url: null, error: 'La foto pesa más de 2MB. Bajá la calidad o usá otra.' };
  }
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
    return { url: null, error: 'Solo aceptamos JPG, PNG o WEBP.' };
  }
  const path = `venta-${ventaId}-${Date.now()}.${ext}`;
  const { error: uploadError } = await dbAnon.storage
    .from('marketplace_review_photos')
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) return { url: null, error: uploadError.message };
  const { data: pub } = dbAnon.storage.from('marketplace_review_photos').getPublicUrl(path);
  return { url: pub.publicUrl, error: null };
}
