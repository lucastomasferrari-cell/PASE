import { db } from '../lib/supabase';

// Servicios públicos del marketplace. NO requieren auth — la RPC SECURITY
// DEFINER fn_marketplace_listar() devuelve solo locales con
// visible_marketplace=TRUE.
//
// Migration: 202605151970_marketplace_inicial.sql

export interface LocalMarketplace {
  id: number;
  nombre: string;
  slug: string;
  marketplace_descripcion: string | null;
  marketplace_tags: string[] | null;
  marketplace_foto_url: string | null;
  online_modo: string | null;
  // Sprint 2026-05-16: horarios + tiempos
  tiempo_retiro_min?: number | null;
  tiempo_delivery_min?: number | null;
  abierto_ahora?: boolean | null;
  horario_hoy?: string | null;
  // Sprint 2026-05-18 (Fase B): coords para filtro por cercanía
  provincia?: string | null;
  localidad?: string | null;
  lat?: number | null;
  lon?: number | null;
}

export async function listMarketplaceLocales(): Promise<{ data: LocalMarketplace[]; error: string | null }> {
  const { data, error } = await db.rpc('fn_marketplace_listar');
  if (error) return { data: [], error: error.message };
  return { data: (data ?? []) as LocalMarketplace[], error: null };
}
