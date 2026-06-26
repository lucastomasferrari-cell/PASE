// Hub central de credenciales del tenant. CRUD via /api/auth-admin (PASE)
// con acciones credencial-list / credencial-set / credencial-delete / credencial-test.
//
// Filosofía: el dueño/admin del local pega los tokens de WhatsApp/Email/etc
// y queda activado para todos los flujos (MESA confirma reservas auto, Marketplace
// manda emails, Habitué dispara campañas, etc).

import { db } from '@/lib/supabase';

const PASE_API_BASE = (import.meta.env.VITE_PASE_API_BASE as string | undefined) || 'https://pase-yndx.vercel.app';

export type ProviderId =
  | 'whatsapp_api' | 'email' | 'meta_ads' | 'google_ads' | 'search_console'
  | 'instagram' | 'google_maps' | 'stripe' | 'mp_point';

export type EstadoIntegracion = 'desconectado' | 'conectado' | 'error' | 'probando';

export interface IntegracionRow {
  id: number;
  provider: ProviderId;
  estado: EstadoIntegracion;
  conectado_at: string | null;
  ultima_verificacion_at: string | null;
  ultimo_error: string | null;
  notas: string | null;
  updated_at: string;
  config_keys: string[];
  config_preview: Record<string, unknown> | null;
}

export interface ProviderDef {
  id: ProviderId;
  nombre: string;
  emoji: string;
  categoria: 'Mensajería' | 'Publicidad' | 'Pagos' | 'Reseñas' | 'SEO';
  desbloquea: string;
  campos: Array<{ key: string; label: string; type: 'text' | 'password' | 'email'; placeholder?: string; help?: string }>;
  comoConseguir: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'whatsapp_api', nombre: 'WhatsApp Business API', emoji: '🟢', categoria: 'Mensajería',
    desbloquea: 'Confirmaciones automáticas de reservas, recibos por WA del marketplace, campañas masivas, recordatorios.',
    campos: [
      { key: 'access_token', label: 'Access token', type: 'password', placeholder: 'EAAxxxxx...', help: 'System User token permanente (Meta Business Manager → System Users)' },
      { key: 'phone_number_id', label: 'Phone Number ID', type: 'text', placeholder: '123456789012345', help: 'Meta Business Manager → WhatsApp → Configuración de la API' },
    ],
    comoConseguir: 'business.facebook.com → Configuración del negocio → Cuentas de WhatsApp → Tu número → Configuración de la API. Necesitás un número verificado y plantillas aprobadas para mensajes de marketing.',
  },
  {
    id: 'email', nombre: 'Email (Resend)', emoji: '✉️', categoria: 'Mensajería',
    desbloquea: 'Emails del marketplace (recibimos tu pedido, listo, calificá), campañas de email, recordatorios.',
    campos: [
      { key: 'api_key', label: 'API Key', type: 'password', placeholder: 're_xxxxx', help: 'Resend Dashboard → API Keys' },
      { key: 'from', label: 'From (email del remitente)', type: 'email', placeholder: 'pedidos@tudominio.com', help: 'Dominio verificado en Resend (SPF/DKIM/DMARC)' },
    ],
    comoConseguir: 'resend.com → API Keys → Crear nueva → copiá el re_xxx. Verificá tu dominio en DNS para que los emails no caigan en spam.',
  },
  {
    id: 'meta_ads', nombre: 'Meta Ads (Facebook/Instagram)', emoji: '📘', categoria: 'Publicidad',
    desbloquea: 'Pauta automática en Habitué: gasto, alcance, clicks, conversiones, CAC/ROAS real.',
    campos: [
      { key: 'access_token', label: 'Access token', type: 'password', placeholder: 'EAAxxxxx...' },
      { key: 'ad_account_id', label: 'Ad Account ID', type: 'text', placeholder: 'act_123456789' },
    ],
    comoConseguir: 'developers.facebook.com → Tu app → Marketing API → genera token con permisos ads_read.',
  },
  {
    id: 'google_maps', nombre: 'Google Maps (reseñas)', emoji: '🗺️', categoria: 'Reseñas',
    desbloquea: 'Reseñas de Google centralizadas en Habitué Calidad, alertas de baja calificación.',
    campos: [
      { key: 'api_key', label: 'API Key', type: 'password', placeholder: 'AIzaSyXXX...' },
      { key: 'place_id', label: 'Place ID del local', type: 'text', placeholder: 'ChIJ...' },
    ],
    comoConseguir: 'console.cloud.google.com → APIs → Places API → habilitar + crear API key. Place ID lo sacás en developers.google.com/maps/documentation/places/web-service/place-id.',
  },
  {
    id: 'stripe', nombre: 'Stripe (billing recurrente)', emoji: '💳', categoria: 'Pagos',
    desbloquea: 'Cobro mensual de la suscripción a PASE (admin-console). Trial expiry handling automático.',
    campos: [
      { key: 'secret_key', label: 'Secret Key', type: 'password', placeholder: 'sk_live_xxx', help: 'Stripe Dashboard → Developers → API keys' },
      { key: 'webhook_secret', label: 'Webhook Signing Secret', type: 'password', placeholder: 'whsec_xxx' },
    ],
    comoConseguir: 'dashboard.stripe.com → Developers → API keys → Secret key. Webhook secret lo sacás al crear el endpoint /api/stripe-webhook.',
  },
  {
    id: 'google_ads', nombre: 'Google Ads', emoji: '🔍', categoria: 'Publicidad',
    desbloquea: 'Pauta de Google en Habitué con métricas reales.',
    campos: [
      { key: 'developer_token', label: 'Developer Token', type: 'password' },
      { key: 'customer_id', label: 'Customer ID', type: 'text', placeholder: '123-456-7890' },
      { key: 'refresh_token', label: 'OAuth Refresh Token', type: 'password' },
    ],
    comoConseguir: 'ads.google.com → API Center. Más complicado que Meta — requiere OAuth flow.',
  },
];

async function authHeaders(): Promise<Record<string, string> | null> {
  const { data } = await db.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export async function listIntegraciones(): Promise<{ data: IntegracionRow[]; error: string | null }> {
  const headers = await authHeaders();
  if (!headers) return { data: [], error: 'sesión_expirada' };
  try {
    const r = await fetch(`${PASE_API_BASE}/api/auth-admin`, {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'credencial-list' }),
    });
    const d = await r.json();
    if (!d.ok) return { data: [], error: d.error || 'error_listando' };
    return { data: (d.integraciones ?? []) as IntegracionRow[], error: null };
  } catch (e) {
    return { data: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export async function guardarCredencial(provider: ProviderId, config: Record<string, string>, notas?: string): Promise<{ error: string | null }> {
  const headers = await authHeaders();
  if (!headers) return { error: 'sesión_expirada' };
  try {
    const r = await fetch(`${PASE_API_BASE}/api/auth-admin`, {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'credencial-set', provider, config, notas }),
    });
    const d = await r.json();
    return { error: d.ok ? null : (d.error || 'error_guardando') };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function borrarCredencial(provider: ProviderId): Promise<{ error: string | null }> {
  const headers = await authHeaders();
  if (!headers) return { error: 'sesión_expirada' };
  try {
    const r = await fetch(`${PASE_API_BASE}/api/auth-admin`, {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'credencial-delete', provider }),
    });
    const d = await r.json();
    return { error: d.ok ? null : (d.error || 'error_borrando') };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function probarCredencial(provider: ProviderId): Promise<{ ok: boolean; error?: string }> {
  const headers = await authHeaders();
  if (!headers) return { ok: false, error: 'sesión_expirada' };
  try {
    const r = await fetch(`${PASE_API_BASE}/api/auth-admin`, {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'credencial-test', provider }),
    });
    const d = await r.json();
    return { ok: !!d.ok, error: d.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
