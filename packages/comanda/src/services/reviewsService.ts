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
      })),
    },
    error: null,
  };
}

export interface CrearReviewArgs {
  ventaId: number;
  telefono: string;
  rating: number;       // 1-5
  comentario?: string | null;
  email?: string | null;
}

export async function crearReviewPublica(args: CrearReviewArgs): Promise<{ reviewId: string | null; yaExistia: boolean; error: string | null }> {
  const { data, error } = await dbAnon.rpc('fn_crear_review_publica', {
    p_venta_id: args.ventaId,
    p_telefono: args.telefono,
    p_rating: args.rating,
    p_comentario: args.comentario ?? null,
    p_email: args.email ?? null,
  });
  if (error) return { reviewId: null, yaExistia: false, error: translateError(error) };
  const obj = data as { review_id: string; ya_existia: boolean };
  return { reviewId: obj.review_id, yaExistia: !!obj.ya_existia, error: null };
}
