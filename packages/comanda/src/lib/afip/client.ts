import { db } from '../supabase';
import type { AfipCredencialesPublic, AfipFacturaInput, AfipFacturaResult } from './types';

/**
 * Cliente browser-side de AFIP facturación electrónica.
 *
 * IMPORTANTE: este cliente NO emite facturas directamente. Las facturas
 * se emiten desde un endpoint server-side (Vercel Function o Supabase
 * Edge Function) que tiene acceso al cert + key del tenant. La key
 * privada NUNCA sale del server.
 *
 * El flow es:
 *   1. UI llama emitirFactura(...) con datos de la venta.
 *   2. Este cliente llama al endpoint POST /api/afip-cae con JWT user.
 *   3. El endpoint valida JWT, lee cert/key del tenant via service_role,
 *      firma CMS para WSAA, obtiene token (cacheado 12hs), llama WSFEv1
 *      con la factura, guarda CAE en afip_facturas + actualiza venta_pos.
 *   4. Devuelve el CAE + QR URL al cliente.
 *
 * ✅ ENDPOINT DESPLEGADO (2026-05-18):
 * Se eliminó /api/mp-webhook (no usado) y se agregó /api/afip-cae. Sigue
 * en 12/12 functions Vercel Hobby. Solo está disponible cuando COMANDA
 * corre embebida en el deploy de PASE (build:comanda-into-pase). Si en
 * el futuro COMANDA se deploya standalone, hace falta un rewrite del
 * vercel.json de COMANDA que proxy /api/* al dominio de PASE — o
 * harcodear la URL completa acá.
 */

const ENDPOINT_URL = '/api/afip-cae';

export async function getCredencialesAFIP(): Promise<AfipCredencialesPublic | null> {
  const { data, error } = await db
    .from('afip_credenciales')
    .select('tenant_id, cuit, ambiente, punto_venta, tipo_contribuyente, cert_vence_at, ultimo_token_at, activa')
    .maybeSingle();
  if (error || !data) return null;
  return data as AfipCredencialesPublic;
}

export async function emitirFactura(input: AfipFacturaInput): Promise<AfipFacturaResult> {
  const sess = (await db.auth.getSession()).data.session;
  if (!sess?.access_token) {
    throw new Error('Sesión expirada. Volvé a entrar.');
  }

  const resp = await fetch(ENDPOINT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sess.access_token}`,
    },
    body: JSON.stringify(input),
  });

  if (resp.status === 404) {
    throw new Error(
      'AFIP_ENDPOINT_NO_DESPLEGADO: el endpoint /api/afip-cae no está disponible. ' +
      'Pasar a Vercel Pro o mover a Supabase Edge Functions.'
    );
  }

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      detail = j.error?.message || JSON.stringify(j).slice(0, 200);
    } catch { /* fallback */ }
    throw new Error(`AFIP rechazó: ${detail}`);
  }

  return await resp.json();
}

/**
 * Lista las últimas facturas emitidas del tenant (para historial UI).
 */
export async function listarFacturasAFIP(limit = 50): Promise<Array<{
  id: number;
  venta_pos_id: number | null;
  tipo_comprobante: number;
  numero: number;
  importe_total: number;
  cae: string | null;
  cae_vence_at: string | null;
  qr_fiscal_url: string | null;
  estado: string;
  emitida_at: string | null;
}>> {
  const { data, error } = await db
    .from('afip_facturas')
    .select('id, venta_pos_id, tipo_comprobante, numero, importe_total, cae, cae_vence_at, qr_fiscal_url, estado, emitida_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as Array<{
    id: number;
    venta_pos_id: number | null;
    tipo_comprobante: number;
    numero: number;
    importe_total: number;
    cae: string | null;
    cae_vence_at: string | null;
    qr_fiscal_url: string | null;
    estado: string;
    emitida_at: string | null;
  }>;
}
