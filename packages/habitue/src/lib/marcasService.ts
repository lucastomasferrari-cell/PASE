// marcasService — marcas del tenant (Neko Sushi, Maneki, Rene…). Se usan para el
// selector de marca del sidebar y para derivar el remitente de las campañas de
// email (nombre = marca, email = <slug>@mailing.comanda.lat).

import { db } from './supabase';

export interface Marca {
  id: number;
  nombre: string;
  slug: string;
  logo_url: string | null;
  color_primary: string | null;
}

const DOMINIO_MKT = 'mailing.comanda.lat';

export async function listMarcas(): Promise<Marca[]> {
  const { data } = await db().from('marcas')
    .select('id, nombre, slug, logo_url, color_primary')
    .eq('activo', true).is('deleted_at', null)
    .order('orden', { ascending: true });
  return (data ?? []) as Marca[];
}

// Remitente por defecto de una marca: "Neko Sushi <neko@mailing.comanda.lat>".
export function remitenteDeMarca(m: Marca | null): { nombre: string; email: string } | null {
  if (!m) return null;
  return { nombre: m.nombre, email: `${m.slug}@${DOMINIO_MKT}` };
}
