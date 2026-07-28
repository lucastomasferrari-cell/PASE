// Meta Pixel (Facebook/Instagram) para la web pública.
//
// El Pixel ID es POR CLIENTE (se lee de fn_meta_pixel_publico por slug). Si el
// local no tiene Meta activo, no se inicializa nada.
//
// Para deduplicar con las conversiones que manda el servidor (Conversions API),
// el evento de reserva del cliente y el del server comparten un `event_id`.

/** Inicializa el Pixel (una vez) + dispara PageView. */
export function initPixel(pixelId: string): void {
  if (!pixelId) return;
  const w = window as unknown as { fbq?: FbqFn; _fbq?: FbqFn };
  if (w.fbq) return; // ya inicializado

  const n = function (...args: unknown[]) {
    const f = n as unknown as { callMethod?: (...a: unknown[]) => void; queue: unknown[] };
    if (f.callMethod) { f.callMethod(...args); } else { f.queue.push(args); }
  } as unknown as FbqFn & { queue: unknown[]; loaded: boolean; version: string; push: unknown };
  w.fbq = n;
  if (!w._fbq) w._fbq = n;
  n.push = n;
  n.loaded = true;
  n.version = '2.0';
  n.queue = [];

  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://connect.facebook.net/en_US/fbevents.js';
  document.head.appendChild(s);

  n('init', pixelId);
  n('track', 'PageView');
}

/** Dispara el evento de reserva (Schedule) con event_id para dedup con CAPI. */
export function trackReservaPixel(eventId: string, value?: number): void {
  const w = window as unknown as { fbq?: FbqFn };
  if (!w.fbq) return;
  w.fbq('track', 'Schedule', value ? { value, currency: 'ARS' } : {}, { eventID: eventId });
}

/** Cookies _fbp/_fbc para mejorar el matching de la CAPI. */
export function getFbCookies(fbclid?: string | null): { fbp?: string; fbc?: string } {
  const read = (k: string): string | undefined => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)'));
    return m && m[1] != null ? decodeURIComponent(m[1]) : undefined;
  };
  let fbc = read('_fbc');
  // Si no hay cookie _fbc pero vino el fbclid en la URL, lo armamos al formato de Meta.
  if (!fbc && fbclid) fbc = `fb.1.${Date.now()}.${fbclid}`;
  return { fbp: read('_fbp'), fbc };
}

/** ID de evento para deduplicar cliente + servidor. */
export function nuevoEventId(): string {
  try { return crypto.randomUUID(); } catch { return `ev-${Date.now()}-${Math.floor(Math.random() * 1e9)}`; }
}

type FbqFn = (...args: unknown[]) => void;
