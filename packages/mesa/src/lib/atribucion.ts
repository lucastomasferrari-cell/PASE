// Atribución de marketing de la página pública.
//
// Captura de dónde viene el visitante (UTM + click-ids de Meta/Google +
// referrer) en el PRIMER toque de la sesión y lo persiste, para adjuntarlo a
// la reserva cuando el cliente reserva. Así el local mide cuántas reservas
// llegan por pauta, IG orgánico, Google, directo, etc.
//
// Primer toque = no se pisa dentro de la misma sesión (si entró por la pauta y
// después navega, sigue contando la pauta). Se guarda en sessionStorage.

const KEY = 'mesa_atrib_v1';
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

export interface Atribucion {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  gclid?: string;
  referrer?: string;
  landing?: string;
}

const trunc = (s: string): string => s.slice(0, 200);

/**
 * Captura la atribución del primer toque de la sesión. Idempotente: si ya hay
 * atribución guardada, no la pisa. Llamar una vez al bootear la app.
 */
export function capturarAtribucion(): void {
  try {
    if (sessionStorage.getItem(KEY)) return; // primer toque ya capturado

    const p = new URLSearchParams(window.location.search);
    const a: Atribucion = {};

    for (const k of UTM_KEYS) {
      const v = p.get(k);
      if (v) a[k] = trunc(v);
    }
    const fbclid = p.get('fbclid');
    if (fbclid) a.fbclid = trunc(fbclid);
    const gclid = p.get('gclid');
    if (gclid) a.gclid = trunc(gclid);

    // Si vino un click-id de Meta/Google pero sin UTM (pauta sin taggear),
    // inferimos la fuente para que el reporte no lo cuente como "directo".
    if (!a.utm_source && a.fbclid) { a.utm_source = 'facebook'; a.utm_medium = a.utm_medium ?? 'paid'; }
    if (!a.utm_source && a.gclid) { a.utm_source = 'google'; a.utm_medium = a.utm_medium ?? 'cpc'; }

    const ref = document.referrer || '';
    if (ref) a.referrer = trunc(ref);
    a.landing = trunc(window.location.pathname + window.location.search);

    sessionStorage.setItem(KEY, JSON.stringify(a));
  } catch { /* sin sessionStorage (modo privado viejo): seguimos sin atribución */ }
}

/** Devuelve la atribución guardada (o null). Para adjuntar al crear la reserva. */
export function getAtribucion(): Atribucion | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Atribucion) : null;
  } catch {
    return null;
  }
}
