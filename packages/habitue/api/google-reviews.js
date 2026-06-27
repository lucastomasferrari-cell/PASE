// Endpoint de reseñas de Google Maps — a spec (Places API New).
// https://developers.google.com/maps/documentation/places/web-service/place-details
//
// "Solo credenciales": setear en Vercel:
//   GOOGLE_PLACES_API_KEY  → API key con Places API (New) habilitada
//
// Query: ?place_id=ChIJ... (el place_id de tu Perfil de Empresa de Google)
// Respuesta: { ok, configured, rating, total, reviews: [...] }

// SEGURIDAD (fix audit 26-jun CRIT-3): requiere JWT del caller. Antes era
// abierto y permitía agotar la cuota Places API del tenant (cobrada).
import { checkUserAuth } from './_auth.js';

const PLACES_NEW = 'https://places.googleapis.com/v1/places';

export default async function handler(req, res) {
  const auth = await checkUserAuth(req, res);
  if (!auth) return;

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return res.status(200).json({ ok: false, configured: false, error: 'Google Places sin credenciales (GOOGLE_PLACES_API_KEY).' });
  }
  const placeId = req.query.place_id;
  if (!placeId) return res.status(400).json({ ok: false, error: 'Falta place_id' });

  // FieldMask requerido por Places API New.
  const fields = ['displayName', 'rating', 'userRatingCount', 'reviews', 'googleMapsUri'].join(',');

  try {
    const r = await fetch(`${PLACES_NEW}/${encodeURIComponent(placeId)}`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fields,
        'Accept-Language': 'es-AR',
      },
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(200).json({ ok: false, configured: true, error: data?.error?.message || `HTTP ${r.status}`, raw: data });
    }
    return res.status(200).json({
      ok: true,
      configured: true,
      nombre: data?.displayName?.text ?? null,
      rating: data?.rating ?? null,
      total: data?.userRatingCount ?? 0,
      url: data?.googleMapsUri ?? null,
      reviews: (data?.reviews ?? []).map((rv) => ({
        autor: rv?.authorAttribution?.displayName ?? 'Anónimo',
        rating: rv?.rating ?? null,
        texto: rv?.text?.text ?? null,
        publicado: rv?.publishTime ?? null,
        relativo: rv?.relativePublishTimeDescription ?? null,
      })),
    });
  } catch (e) {
    return res.status(200).json({ ok: false, configured: true, error: e instanceof Error ? e.message : String(e) });
  }
}
