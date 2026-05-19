// Helpers de geolocalización. Hoy solo necesitamos distancia entre dos
// puntos lat/lon — la fórmula haversine es suficiente para el orden de
// magnitudes que manejamos (entrega <= 50 km, donde la curvatura terrestre
// vale). PostGIS sería overkill.

const EARTH_RADIUS_KM = 6371;

/**
 * Distancia esférica entre dos puntos lat/lon, en kilómetros.
 *
 * @param lat1 latitud punto A (grados decimales, -90..90)
 * @param lon1 longitud punto A (grados decimales, -180..180)
 * @param lat2 latitud punto B
 * @param lon2 longitud punto B
 * @returns distancia en km (siempre >= 0)
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}
