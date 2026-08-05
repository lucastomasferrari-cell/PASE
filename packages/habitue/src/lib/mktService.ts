// mktService — capa de datos del email marketing (campañas reales por Resend).
//
// Lee/escribe las tablas mkt_* vía Supabase (RLS por tenant) y dispara el envío
// contra el endpoint /api/mkt (que tiene la API key de Resend). Reemplaza al
// campanasService viejo (que era solo wa.me + mailto sin envío real).

import { db } from './supabase';

export type MktEstado =
  | 'borrador' | 'programada' | 'enviando' | 'enviada' | 'pausada' | 'cancelada' | 'error';

export interface MktCampana {
  id: string;
  tenant_id: string;
  nombre: string;
  asunto: string;
  preheader: string | null;
  from_nombre: string | null;
  from_email: string | null;
  reply_to: string | null;
  html: string;
  segmento_nombre: string | null;
  estado: MktEstado;
  programada_para: string | null;
  enviada_at: string | null;
  total_destinatarios: number;
  total_enviados: number;
  total_entregados: number;
  total_aperturas: number;
  total_clicks: number;
  total_rebotes: number;
  total_quejas: number;
  total_bajas: number;
  created_at: string;
  updated_at: string;
}

export interface MktConfig {
  tenant_id: string;
  from_nombre: string;
  from_email: string;
  reply_to: string | null;
  dominio_envio: string;
}

const CAMPOS = 'id,tenant_id,nombre,asunto,preheader,from_nombre,from_email,reply_to,html,segmento_nombre,estado,programada_para,enviada_at,total_destinatarios,total_enviados,total_entregados,total_aperturas,total_clicks,total_rebotes,total_quejas,total_bajas,created_at,updated_at';

// ── POST autenticado a /api/mkt ─────────────────────────────────────────────
async function apiMkt(body: Record<string, unknown>): Promise<any> {
  const { data: sess } = await db().auth.getSession();
  const token = sess.session?.access_token;
  const r = await fetch('/api/mkt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ── Campañas (CRUD vía RLS) ─────────────────────────────────────────────────
export async function listCampanas(): Promise<MktCampana[]> {
  const { data, error } = await db().from('mkt_campanas').select(CAMPOS).order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as MktCampana[];
}

export async function getCampana(id: string): Promise<MktCampana | null> {
  const { data } = await db().from('mkt_campanas').select(CAMPOS).eq('id', id).maybeSingle();
  return (data as MktCampana) ?? null;
}

export async function crearCampana(tenantId: string, c: Partial<MktCampana>): Promise<MktCampana> {
  const { data, error } = await db().from('mkt_campanas')
    .insert({
      tenant_id: tenantId, nombre: c.nombre ?? 'Nueva campaña', asunto: c.asunto ?? '', html: c.html ?? '',
      from_nombre: c.from_nombre ?? null, from_email: c.from_email ?? null,
    })
    .select(CAMPOS).single();
  if (error) throw new Error(error.message);
  return data as MktCampana;
}

export async function actualizarCampana(id: string, patch: Partial<MktCampana>): Promise<void> {
  const { error } = await db().from('mkt_campanas')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function eliminarCampana(id: string): Promise<void> {
  const { error } = await db().from('mkt_campanas').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ── Envío / prueba ──────────────────────────────────────────────────────────
export async function enviarPrueba(campanaId: string, email: string): Promise<{ ok: boolean; error?: string }> {
  return apiMkt({ action: 'test', campana_id: campanaId, email });
}

// Envía la campaña. El endpoint procesa por lotes; acá reintentamos hasta done.
// onProgreso recibe {enviados acumulados, restantes} para mostrar barra.
export async function enviarCampana(
  campanaId: string,
  clienteIds: number[] | null,
  onProgreso?: (p: { enviados: number; restantes: number }) => void,
): Promise<{ ok: boolean; enviados: number; error?: string }> {
  let acum = 0;
  for (let i = 0; i < 100; i++) { // tope de seguridad (100 lotes = 20.000 dest)
    const r = await apiMkt({ action: 'enviar', campana_id: campanaId, ...(i === 0 && clienteIds ? { cliente_ids: clienteIds } : {}) });
    if (!r.ok) return { ok: false, enviados: acum, error: r.error };
    acum += r.enviados ?? 0;
    onProgreso?.({ enviados: acum, restantes: r.restantes ?? 0 });
    if (r.done) return { ok: true, enviados: acum };
  }
  return { ok: false, enviados: acum, error: 'demasiados lotes' };
}

// ── Config remitente ────────────────────────────────────────────────────────
export async function getConfig(): Promise<MktConfig | null> {
  const r = await apiMkt({ action: 'config-get' });
  return r.config ?? null;
}
export async function saveConfig(cfg: Partial<MktConfig>): Promise<MktConfig> {
  const r = await apiMkt({ action: 'config-set', config: cfg });
  if (!r.ok) throw new Error(r.error || 'no se pudo guardar');
  return r.config;
}

// ── Atribución de ventas (cuánto vendiste por la campaña) ───────────────────
export interface Atribucion { compradores: number; ventas: number; ingresos: number; }
export async function atribucionVentas(campanaId: string, dias = 7): Promise<Atribucion> {
  const { data, error } = await db().rpc('fn_mkt_atribucion_ventas', { p_campana_id: campanaId, p_dias: dias });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return { compradores: row?.compradores ?? 0, ventas: row?.ventas ?? 0, ingresos: Number(row?.ingresos ?? 0) };
}

// ── Métricas derivadas ──────────────────────────────────────────────────────
export function tasaApertura(c: MktCampana): number {
  const base = c.total_entregados || c.total_enviados;
  return base ? Math.round((c.total_aperturas / base) * 1000) / 10 : 0;
}
export function tasaClick(c: MktCampana): number {
  const base = c.total_entregados || c.total_enviados;
  return base ? Math.round((c.total_clicks / base) * 1000) / 10 : 0;
}
