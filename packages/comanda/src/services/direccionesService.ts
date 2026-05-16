import { db } from '../lib/supabase';

// Servicio de direcciones híbrido para tienda online:
// - GeoRef (gob.ar) para autocomplete mientras tipea (GRATIS, sin API key)
// - Google Geocoding (opcional) para lat/lon preciso cuando confirma
//
// Sin API key de Google → solo GeoRef. La lat/lon viene del centroide
// de la calle (~50m error). Suficiente para mostrar mini-mapa al cajero.
//
// Con API key de Google → lat/lon exacto del número específico.

const GOOGLE_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY ?? '';

// ─── GeoRef (gob.ar) ──────────────────────────────────────────────────────

export interface DireccionSugerida {
  // Texto formateado que se muestra en el dropdown y se guarda en la venta
  texto: string;
  // Componentes parseados
  calle: string;
  altura: number | null;
  localidad: string | null;
  provincia: string | null;
  // Lat/lon (vienen de GeoRef → centroide calle. Si Google está disponible
  // se sobre-escriben con valor preciso al confirmar)
  lat: number | null;
  lon: number | null;
  // Identificador interno (para deduplicar sugerencias)
  id: string;
}

export interface FiltroGeoRef {
  // Nombre exacto de provincia (ej "Ciudad Autónoma de Buenos Aires").
  // Si está, GeoRef filtra y NO devuelve direcciones de otras provincias.
  provincia?: string | null;
  // Localidad/departamento — prioriza pero no es exclusivo.
  localidad?: string | null;
}

// Llama GeoRef API para autocompletar direcciones.
// Acepta query libre tipo "Av. Corrientes 1234" + filtros opcionales.
// Doc: https://georef.gob.ar/api/direcciones
export async function buscarDirecciones(query: string, filtros: FiltroGeoRef = {}): Promise<DireccionSugerida[]> {
  const q = query.trim();
  if (q.length < 4) return [];
  try {
    const url = new URL('https://apis.datos.gob.ar/georef/api/direcciones');
    url.searchParams.set('direccion', q);
    url.searchParams.set('max', '10');
    url.searchParams.set('campos', 'estandar');
    if (filtros.provincia) url.searchParams.set('provincia', filtros.provincia);
    if (filtros.localidad) url.searchParams.set('localidad_censal', filtros.localidad);
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = await res.json() as {
      direcciones?: Array<{
        nomenclatura?: string;
        calle?: { nombre?: string };
        altura?: { valor?: number };
        localidad_censal?: { nombre?: string };
        provincia?: { nombre?: string };
        ubicacion?: { lat?: number; lon?: number };
      }>;
    };
    return (data.direcciones ?? []).map((d, idx) => ({
      texto: d.nomenclatura ?? `${d.calle?.nombre ?? ''} ${d.altura?.valor ?? ''}, ${d.localidad_censal?.nombre ?? ''}`,
      calle: d.calle?.nombre ?? '',
      altura: d.altura?.valor ?? null,
      localidad: d.localidad_censal?.nombre ?? null,
      provincia: d.provincia?.nombre ?? null,
      lat: d.ubicacion?.lat ?? null,
      lon: d.ubicacion?.lon ?? null,
      id: `gr-${idx}-${d.nomenclatura ?? ''}`,
    }));
  } catch {
    return [];
  }
}

// Listar todas las provincias AR (24, fijo) — para select en SettingsLocal.
// No requiere request a GeoRef porque las 24 nunca cambian.
export const PROVINCIAS_AR = [
  'Buenos Aires',
  'Ciudad Autónoma de Buenos Aires',
  'Catamarca',
  'Chaco',
  'Chubut',
  'Córdoba',
  'Corrientes',
  'Entre Ríos',
  'Formosa',
  'Jujuy',
  'La Pampa',
  'La Rioja',
  'Mendoza',
  'Misiones',
  'Neuquén',
  'Río Negro',
  'Salta',
  'San Juan',
  'San Luis',
  'Santa Cruz',
  'Santa Fe',
  'Santiago del Estero',
  'Tierra del Fuego, Antártida e Islas del Atlántico Sur',
  'Tucumán',
];

// Buscar localidades dentro de una provincia (para el select cascada en
// SettingsLocal). Doc: https://georef.gob.ar/api/localidades-censales
export async function buscarLocalidades(provincia: string, query: string = ''): Promise<string[]> {
  if (!provincia) return [];
  try {
    const url = new URL('https://apis.datos.gob.ar/georef/api/localidades-censales');
    url.searchParams.set('provincia', provincia);
    if (query.trim()) url.searchParams.set('nombre', query.trim());
    url.searchParams.set('max', '20');
    url.searchParams.set('campos', 'nombre');
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = await res.json() as {
      localidades_censales?: Array<{ nombre: string }>;
    };
    return (data.localidades_censales ?? []).map((l) => l.nombre);
  } catch {
    return [];
  }
}

// ─── Google Geocoding (opcional, mejora lat/lon precisión) ─────────────────

export interface CoordPrecisas {
  lat: number;
  lon: number;
  formatted: string;
}

// Llama Google Geocoding solo cuando el cliente confirma una dirección.
// Devuelve null si no hay API key o falla.
// Doc: https://developers.google.com/maps/documentation/geocoding/overview
export async function precisarConGoogle(direccion: string): Promise<CoordPrecisas | null> {
  if (!GOOGLE_KEY) return null;
  try {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', direccion);
    url.searchParams.set('region', 'ar');
    url.searchParams.set('components', 'country:AR');
    url.searchParams.set('key', GOOGLE_KEY);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json() as {
      status: string;
      results?: Array<{
        geometry?: { location?: { lat?: number; lng?: number } };
        formatted_address?: string;
      }>;
    };
    if (data.status !== 'OK' || !data.results?.[0]) return null;
    const r = data.results[0];
    const loc = r.geometry?.location;
    if (!loc?.lat || !loc?.lng) return null;
    return {
      lat: loc.lat,
      lon: loc.lng,
      formatted: r.formatted_address ?? direccion,
    };
  } catch {
    return null;
  }
}

// ─── Persistir lat/lon en la venta ────────────────────────────────────────

export async function setPedidoGeo(ventaId: number, lat: number, lon: number): Promise<{ error: string | null }> {
  const { error } = await db.rpc('fn_set_pedido_geo', {
    p_venta_id: ventaId,
    p_lat: lat,
    p_lon: lon,
  });
  return { error: error?.message ?? null };
}

// ─── Distancia haversine entre 2 puntos (km) ──────────────────────────────
// Útil para calcular si el cliente está dentro del radio de delivery.
export function distanciaKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // radio Tierra km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
