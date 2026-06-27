// integraciones — capa "integration-ready" de Habitué.
//
// Cada capacidad externa (WhatsApp Cloud API, email, Meta/Google Ads, Google
// Maps, Search Console, IG) tiene su adapter front que pega al endpoint
// serverless en `api/*` ya escrito a spec del proveedor. "Solo credenciales":
// setear las env vars del proyecto Vercel → empieza a funcionar sin tocar código.
// El hub Integraciones consulta /api/integraciones-health para mostrar estado.

export type ProviderId =
  | 'whatsapp_api' | 'email' | 'meta_ads' | 'google_ads' | 'search_console' | 'instagram' | 'google_maps';
export type EstadoIntegracion = 'desconectado' | 'conectado' | 'error';

export interface IntegracionDef {
  id: ProviderId;
  nombre: string;
  categoria: 'Mensajería' | 'Publicidad' | 'SEO' | 'Reputación';
  emoji: string;
  descripcion: string;
  desbloquea: string;     // qué habilita conectarla
  comoConectar: string;   // qué se necesita (para cuando se integre)
}

export const INTEGRACIONES: IntegracionDef[] = [
  {
    id: 'whatsapp_api', nombre: 'WhatsApp Business API', categoria: 'Mensajería', emoji: '',
    descripcion: 'Envío masivo y automático de campañas por WhatsApp (hoy es link por link).',
    desbloquea: 'Campañas masivas automáticas, plantillas aprobadas, respuestas 2 vías y el bot de WhatsApp.',
    comoConectar: 'Cuenta de WhatsApp Business API (Meta) o un BSP (Twilio/360dialog) + número verificado + plantillas aprobadas.',
  },
  {
    id: 'email', nombre: 'Email (Resend/SendGrid)', categoria: 'Mensajería', emoji: '',
    descripcion: 'Envío de campañas por email con tracking de aperturas (hoy es mailto BCC).',
    desbloquea: 'Emails masivos con plantilla, tasa de apertura/clicks, dominio verificado.',
    comoConectar: 'API key de Resend o SendGrid + verificación de dominio (SPF/DKIM).',
  },
  {
    id: 'meta_ads', nombre: 'Meta Ads', categoria: 'Publicidad', emoji: '',
    descripcion: 'Trae el gasto y las métricas de tus campañas de Facebook/Instagram (hoy es carga manual).',
    desbloquea: 'Pauta automática: gasto, alcance, clicks, conversiones y CAC/ROAS reales.',
    comoConectar: 'OAuth con Meta Marketing API + ad account id.',
  },
  {
    id: 'google_ads', nombre: 'Google Ads', categoria: 'Publicidad', emoji: '',
    descripcion: 'Trae el gasto y métricas de tus campañas de Google (hoy es carga manual).',
    desbloquea: 'Pauta automática de Google + CAC/ROAS reales.',
    comoConectar: 'OAuth con Google Ads API + customer id + developer token.',
  },
  {
    id: 'search_console', nombre: 'Google Search Console', categoria: 'SEO', emoji: '',
    descripcion: 'Posicionamiento orgánico: qué búsquedas te traen, clicks e impresiones.',
    desbloquea: 'SEO: keywords, posición promedio, CTR, páginas que rankean.',
    comoConectar: 'OAuth con Search Console API + propiedad verificada del sitio.',
  },
  {
    id: 'instagram', nombre: 'Instagram (bot/DM)', categoria: 'Mensajería', emoji: '',
    descripcion: 'Conecta el bot de Instagram para campañas y respuestas por DM.',
    desbloquea: 'Campañas y automatizaciones por DM de IG, unificadas con el CRM.',
    comoConectar: 'Instagram Graph API (ya hay app IG en el ecosistema) + permisos de mensajería.',
  },
  {
    id: 'google_maps', nombre: 'Google Maps (reseñas)', categoria: 'Reputación', emoji: '',
    descripcion: 'Trae tus reseñas de Google Maps al control de calidad (hoy se piden a mano).',
    desbloquea: 'Reseñas de Google centralizadas, alertas de baja calificación y pedido automático de reseña tras la visita.',
    comoConectar: 'Google Business Profile API (Places) + OAuth + place_id del local.',
  },
];

// ─── Estado de cada provider — pregunta al endpoint /api/integraciones-health,
// que mira las env vars del proyecto Vercel. "Conectado" = credenciales presentes.
export async function listEstados(): Promise<{ estados: Record<string, EstadoIntegracion>; sinTabla: boolean; error: string | null }> {
  try {
    const r = await fetch('/api/integraciones-health');
    const data = (await r.json()) as { ok: boolean; providers?: Record<string, boolean> };
    if (!data.ok || !data.providers) return { estados: {}, sinTabla: false, error: null };
    const estados: Record<string, EstadoIntegracion> = {};
    for (const [k, v] of Object.entries(data.providers)) estados[k] = v ? 'conectado' : 'desconectado';
    return { estados, sinTabla: false, error: null };
  } catch (e) {
    return { estados: {}, sinTabla: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Interfaces que la integración REAL va a implementar ──────────────────────
export interface MessagingProvider {
  enviar(to: string, mensaje: string): Promise<{ ok: boolean; error?: string }>;
}
export interface EmailProvider {
  enviar(to: string[], asunto: string, cuerpo: string): Promise<{ ok: boolean; error?: string }>;
}
export interface AdInsights { gasto: number; alcance: number; clicks: number; conversiones: number; }
export interface AdsProvider {
  getInsights(desde: string, hasta: string): Promise<AdInsights | null>;
}

// ─── Adapters: hablan con los endpoints serverless (/api/*) que ya están a spec.
// "Solo credenciales": cuando se setean las env vars en Vercel, esto empieza a
// funcionar sin cambiar una línea de código. Sin credenciales, devuelve un
// error claro y la app cae elegante al modo manual (wa.me / mailto).

export const whatsappProvider: MessagingProvider = {
  async enviar(to: string, mensaje: string) {
    try {
      const r = await fetch('/api/whatsapp-send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, texto: mensaje }),
      });
      const data = (await r.json()) as { ok: boolean; configured?: boolean; error?: string };
      if (!data.ok) return { ok: false, error: data.error ?? 'No se pudo enviar' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const emailProvider: EmailProvider = {
  async enviar(to: string[], asunto: string, cuerpo: string) {
    try {
      const r = await fetch('/api/email-send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, asunto, texto: cuerpo }),
      });
      const data = (await r.json()) as { ok: boolean; configured?: boolean; error?: string };
      if (!data.ok) return { ok: false, error: data.error ?? 'No se pudo enviar' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

export const metaAdsProvider: AdsProvider = {
  async getInsights(desde: string, hasta: string) {
    try {
      const r = await fetch(`/api/meta-ads-insights?desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`);
      const data = (await r.json()) as { ok: boolean; insights?: AdInsights };
      if (!data.ok || !data.insights) return null;
      return data.insights;
    } catch { return null; }
  },
};
