// reviewsService — reseñas del local para el panel MESA.
// Port de COMANDA: RPC anon `fn_listar_reviews_publicas(p_local_slug)` que
// devuelve hasta 50 reseñas + resumen (promedio + total). Reseñas que dejan
// los clientes tras un pedido/visita.

import { db } from './supabase';

export interface Review {
  review_id: string;
  autor_nombre: string;
  rating: number;
  comentario: string | null;
  created_at: string;
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

export async function listarReviews(localSlug: string): Promise<{ data: ReviewsResumen; error: string | null }> {
  const vacio: ReviewsResumen = { total_reviews: 0, rating_promedio: null, reviews: [] };
  if (!localSlug) return { data: vacio, error: null };
  const { data, error } = await db().rpc('fn_listar_reviews_publicas', { p_local_slug: localSlug });
  if (error) return { data: vacio, error: error.message };
  const rows = (data as Array<Review & { total_reviews: number; rating_promedio: number }>) ?? [];
  if (rows.length === 0) return { data: vacio, error: null };
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
        estrellas_comida: r.estrellas_comida ?? null,
        estrellas_entrega: r.estrellas_entrega ?? null,
        estrellas_presentacion: r.estrellas_presentacion ?? null,
        foto_url: r.foto_url ?? null,
      })),
    },
    error: null,
  };
}
