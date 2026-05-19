import { db } from '../supabase';
import type {
  AfipCredencialesPublic, AfipFacturaInput, AfipFacturaResult,
  AfipTipoComprobante, AfipDocTipo,
} from './types';

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
 * Anula una factura emitiendo la nota de crédito correspondiente.
 * AFIP no permite "borrar" facturas — se anulan emitiendo una NC del
 * mismo monto, mismo tipo (B → NC B, C → NC C, A → NC A) con referencia
 * al comprobante original. La NC se guarda en afip_facturas como una
 * fila más con estado 'aprobada' (no es lo mismo que estado='anulada' —
 * eso último es para facturas que fallaron en emitirse).
 *
 * Mapeo tipo factura → tipo NC:
 *   Factura A (1)  → NC A (3)
 *   Factura B (6)  → NC B (8)
 *   Factura C (11) → NC C (13)
 */
export async function anularFacturaConNC(args: {
  factura_original_id: number;
  factura_original_tipo: AfipTipoComprobante;
  factura_original_numero: number;
  punto_venta: number;
  cuit_emisor: string;
  importe_neto: number;
  importe_iva: number;
  importe_total: number;
  venta_pos_id: number;
  doc_tipo?: AfipDocTipo;
  doc_nro?: string;
  cliente_razon_social?: string;
}): Promise<AfipFacturaResult> {
  // Mapeo tipo origen → tipo NC.
  const tipoNC = args.factura_original_tipo === 1 ? 3
              : args.factura_original_tipo === 6 ? 8
              : args.factura_original_tipo === 11 ? 13
              : null;
  if (!tipoNC) {
    throw new Error(`No hay mapeo NC para tipo de comprobante ${args.factura_original_tipo}`);
  }

  return await emitirFactura({
    tenant_id: '', // server lo resuelve via JWT
    venta_pos_id: args.venta_pos_id,
    tipo_comprobante: tipoNC,
    importe_neto: args.importe_neto,
    importe_iva: args.importe_iva,
    importe_total: args.importe_total,
    concepto: 1,
    doc_tipo: args.doc_tipo,
    doc_nro: args.doc_nro,
    cliente_razon_social: args.cliente_razon_social,
    request_uuid: crypto.randomUUID(),
    cbtes_asoc: [{
      tipo: args.factura_original_tipo,
      pto_vta: args.punto_venta,
      numero: args.factura_original_numero,
      cuit: args.cuit_emisor,
    }],
  });
}

/**
 * Lista las últimas facturas emitidas del tenant (para historial UI).
 * Incluye los campos necesarios para emitir NC (importe_neto/iva, doc_*,
 * razón social, punto_venta).
 */
export async function listarFacturasAFIP(limit = 50): Promise<Array<{
  id: number;
  venta_pos_id: number | null;
  tipo_comprobante: number;
  numero: number;
  punto_venta: number;
  importe_neto: number;
  importe_iva: number;
  importe_total: number;
  doc_tipo: number | null;
  doc_nro: string | null;
  cliente_razon_social: string | null;
  cae: string | null;
  cae_vence_at: string | null;
  qr_fiscal_url: string | null;
  estado: string;
  emitida_at: string | null;
}>> {
  const { data, error } = await db
    .from('afip_facturas')
    .select('id, venta_pos_id, tipo_comprobante, numero, punto_venta, importe_neto, importe_iva, importe_total, doc_tipo, doc_nro, cliente_razon_social, cae, cae_vence_at, qr_fiscal_url, estado, emitida_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as Array<{
    id: number;
    venta_pos_id: number | null;
    tipo_comprobante: number;
    numero: number;
    punto_venta: number;
    importe_neto: number;
    importe_iva: number;
    importe_total: number;
    doc_tipo: number | null;
    doc_nro: string | null;
    cliente_razon_social: string | null;
    cae: string | null;
    cae_vence_at: string | null;
    qr_fiscal_url: string | null;
    estado: string;
    emitida_at: string | null;
  }>;
}
