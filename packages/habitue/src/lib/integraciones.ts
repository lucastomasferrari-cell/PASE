// integraciones — capa "integration-ready" de Habitué.
//
// Idea: cada capacidad externa (WhatsApp Business API, email, Meta/Google Ads,
// Search Console) está DISEÑADA como si ya se usara. Hay (a) un REGISTRY que
// describe cada integración para el hub, (b) interfaces tipadas que la
// implementación real va a cumplir, y (c) adapters STUB con un único punto
// `// TODO: integración` donde va la llamada a la API. Conectar = reemplazar el
// stub por la impl real + cargar credenciales. Nada más cambia en la app.

import { db } from './supabase';

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
    id: 'whatsapp_api', nombre: 'WhatsApp Business API', categoria: 'Mensajería', emoji: '🟢',
    descripcion: 'Envío masivo y automático de campañas por WhatsApp (hoy es link por link).',
    desbloquea: 'Campañas masivas automáticas, plantillas aprobadas, respuestas 2 vías y el bot de WhatsApp.',
    comoConectar: 'Cuenta de WhatsApp Business API (Meta) o un BSP (Twilio/360dialog) + número verificado + plantillas aprobadas.',
  },
  {
    id: 'email', nombre: 'Email (Resend/SendGrid)', categoria: 'Mensajería', emoji: '✉️',
    descripcion: 'Envío de campañas por email con tracking de aperturas (hoy es mailto BCC).',
    desbloquea: 'Emails masivos con plantilla, tasa de apertura/clicks, dominio verificado.',
    comoConectar: 'API key de Resend o SendGrid + verificación de dominio (SPF/DKIM).',
  },
  {
    id: 'meta_ads', nombre: 'Meta Ads', categoria: 'Publicidad', emoji: '📘',
    descripcion: 'Trae el gasto y las métricas de tus campañas de Facebook/Instagram (hoy es carga manual).',
    desbloquea: 'Pauta automática: gasto, alcance, clicks, conversiones y CAC/ROAS reales.',
    comoConectar: 'OAuth con Meta Marketing API + ad account id.',
  },
  {
    id: 'google_ads', nombre: 'Google Ads', categoria: 'Publicidad', emoji: '🔍',
    descripcion: 'Trae el gasto y métricas de tus campañas de Google (hoy es carga manual).',
    desbloquea: 'Pauta automática de Google + CAC/ROAS reales.',
    comoConectar: 'OAuth con Google Ads API + customer id + developer token.',
  },
  {
    id: 'search_console', nombre: 'Google Search Console', categoria: 'SEO', emoji: '📈',
    descripcion: 'Posicionamiento orgánico: qué búsquedas te traen, clicks e impresiones.',
    desbloquea: 'SEO: keywords, posición promedio, CTR, páginas que rankean.',
    comoConectar: 'OAuth con Search Console API + propiedad verificada del sitio.',
  },
  {
    id: 'instagram', nombre: 'Instagram (bot/DM)', categoria: 'Mensajería', emoji: '📸',
    descripcion: 'Conecta el bot de Instagram para campañas y respuestas por DM.',
    desbloquea: 'Campañas y automatizaciones por DM de IG, unificadas con el CRM.',
    comoConectar: 'Instagram Graph API (ya hay app IG en el ecosistema) + permisos de mensajería.',
  },
  {
    id: 'google_maps', nombre: 'Google Maps (reseñas)', categoria: 'Reputación', emoji: '🗺️',
    descripcion: 'Trae tus reseñas de Google Maps al control de calidad (hoy se piden a mano).',
    desbloquea: 'Reseñas de Google centralizadas, alertas de baja calificación y pedido automático de reseña tras la visita.',
    comoConectar: 'Google Business Profile API (Places) + OAuth + place_id del local.',
  },
];

// ─── Estado persistido (tabla integraciones; graceful si no migrada) ──────────
function faltaTabla(msg: string) {
  return /relation .*integraciones.* does not exist/i.test(msg) || /could not find the table/i.test(msg);
}

export async function listEstados(): Promise<{ estados: Record<string, EstadoIntegracion>; sinTabla: boolean; error: string | null }> {
  const { data, error } = await db().from('integraciones').select('provider, estado');
  if (error) {
    if (faltaTabla(error.message)) return { estados: {}, sinTabla: true, error: null };
    return { estados: {}, sinTabla: false, error: error.message };
  }
  const estados: Record<string, EstadoIntegracion> = {};
  for (const r of (data ?? []) as { provider: string; estado: EstadoIntegracion }[]) estados[r.provider] = r.estado;
  return { estados, sinTabla: false, error: null };
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

// ─── Adapters STUB (hoy). Único lugar a reemplazar al integrar. ───────────────
export const whatsappProvider: MessagingProvider = {
  async enviar(/* to, mensaje */) {
    // TODO: integración — POST a WhatsApp Business API (Meta/BSP) con plantilla.
    // Por ahora el envío es manual vía links wa.me en el composer.
    return { ok: false, error: 'WhatsApp API no conectada — usá los links wa.me del composer.' };
  },
};

export const emailProvider: EmailProvider = {
  async enviar(/* to, asunto, cuerpo */) {
    // TODO: integración — POST a Resend/SendGrid. Por ahora se usa mailto BCC.
    return { ok: false, error: 'Email no conectado — usá el mailto BCC del composer.' };
  },
};

export const metaAdsProvider: AdsProvider = {
  async getInsights(/* desde, hasta */) {
    // TODO: integración — Meta Marketing API /insights. Por ahora la pauta es manual.
    return null;
  },
};
