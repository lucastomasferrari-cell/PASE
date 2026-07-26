// /api/afip-cae — emisión de CAE (factura electrónica AR) via AFIP WSFEv1.
//
// Flujo:
//   1. Valida JWT del user (tenant_id derivado).
//   2. Idempotency: si vino p_request_uuid y ya hay factura con ese uuid,
//      devuelve el CAE cacheado (sin pegarle de nuevo a AFIP).
//   3. Lee credenciales del tenant (cert + key, solo accesible vía service_role).
//   4. Conexión DIRECTA a ARCA vía _afip-direct.js (WSAA + WSFEv1, sin terceros).
//   5. feUltimoAutorizado → numero = ultimo + 1.
//   6. feCAESolicitar → CAE.
//   7. Genera QR fiscal AR (Res. Gral. 4892/2020).
//   8. INSERT afip_facturas con estado 'aprobada'.
//   9. Devuelve { cae, numero, qr_fiscal_url, factura_id }.
//
// SEGURIDAD:
//   - Cert + key PEM están en afip_credenciales con RLS dura: solo
//     service_role puede leerlos. JAMÁS llegan al browser.
//   - JWT del user se valida con SUPABASE_JWT_SECRET (mismo patrón que
//     mp-sync, telegram-webhook).
//   - El tenant_id viene del JWT, no del body → no se puede forzar facturar
//     por otro tenant.
//
// Configuración env vars Vercel:
//   - SUPABASE_URL                  (ya existe)
//   - SUPABASE_SERVICE_KEY          (ya existe)
//   El auth del user usa _user-auth.js (helper compartido del repo, no
//   requiere jsonwebtoken — usa supabase.auth.getUser(token) que valida el
//   JWT contra el GoTrue del proyecto).
//
// Ambiente AFIP:
//   - testing: AFIP Homologación (WSAA testing) — NO requiere cert real,
//     se puede generar uno de prueba. Las facturas NO tienen valor fiscal.
//   - produccion: AFIP real (WSAA producción) — requiere cert oficial
//     emitido por AFIP web con CUIT + huella + nivel 3+. CAE retornado
//     es válido fiscalmente.

import { createClient } from '@supabase/supabase-js';
import { feUltimoAutorizado, feCAESolicitar, buildQrUrl } from './_afip-direct.js';
import { checkUserAuth } from './_user-auth.js';
import { setCorsHeaders } from './_cors.js';

export default async function handler(req, res) {
  // Fix auditoría 2026-05-21 ALTO-5: CORS allow-list explícito.
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });

  // ── Auth: JWT del user (helper compartido) ────────────────────────────
  const auth = await checkUserAuth(req, res);
  if (!auth) return; // helper ya envió 401/403/500
  const tenantId = auth.row.tenant_id;
  const usuarioId = auth.row.id;
  if (!tenantId) return res.status(403).json({ error: 'USER_SIN_TENANT' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Body validation ───────────────────────────────────────────────────
  const body = req.body || {};
  const requiredFields = ['venta_pos_id', 'tipo_comprobante', 'importe_neto', 'importe_iva', 'importe_total', 'concepto', 'request_uuid'];
  for (const f of requiredFields) {
    if (body[f] === undefined || body[f] === null) {
      return res.status(400).json({ error: 'MISSING_FIELD', field: f });
    }
  }

  // ── Idempotency: si ya hay factura aprobada con este request_uuid, devolver cache ──
  // AUDIT F2C #3: agregar filtro por tenant_id. Sin esto, si un atacante de tenant B
  // aprende un request_uuid de tenant A (por logs/network), puede recibir el CAE/QR
  // fiscal completo de tenant A.
  const { data: prev } = await supabase
    .from('afip_facturas')
    .select('id, cae, cae_vence_at, numero, qr_fiscal_url, estado, rechazo_motivo')
    .eq('request_uuid', body.request_uuid)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (prev?.cae) {
    return res.status(200).json({
      factura_id: prev.id,
      cae: prev.cae,
      cae_vence_at: prev.cae_vence_at,
      numero: prev.numero,
      qr_fiscal_url: prev.qr_fiscal_url,
      estado: prev.estado,
      rechazo_motivo: prev.rechazo_motivo,
      cached: true,
    });
  }

  // ── Credenciales del tenant ───────────────────────────────────────────
  const { data: cred, error: credErr } = await supabase
    .from('afip_credenciales')
    .select('cuit, ambiente, cert_pem, key_pem, punto_venta, activa, tipo_contribuyente')
    .eq('tenant_id', tenantId)
    .single();
  if (credErr || !cred) return res.status(400).json({ error: 'AFIP_NO_CONFIGURADA' });
  if (!cred.activa) return res.status(400).json({ error: 'AFIP_NO_ACTIVA' });
  if (!cred.cert_pem || !cred.key_pem) return res.status(400).json({ error: 'AFIP_SIN_CERT_KEY' });

  // Credenciales para el módulo DIRECTO a ARCA (WSAA + WSFEv1, sin terceros).
  const credD = {
    certPem: cred.cert_pem, keyPem: cred.key_pem,
    cuit: cred.cuit, ambiente: cred.ambiente,
  };

  // ── Punto de venta del LOCAL de la venta ──────────────────────────────
  // Multi-sucursal: cada local tiene su propio PV bajo el mismo CUIT
  // (locales.afip_punto_venta). Si el local no lo tiene configurado, NO
  // emitimos — evita facturar con un PV que no le corresponde. Ver
  // migración 202607221900. (cred.punto_venta queda como legado, no se usa.)
  let ptoVta = null;
  {
    const { data: vRow } = await supabase
      .from('ventas_pos').select('local_id').eq('id', body.venta_pos_id).eq('tenant_id', tenantId).single();
    if (vRow?.local_id != null) {
      const { data: lRow } = await supabase
        .from('locales').select('afip_punto_venta').eq('id', vRow.local_id).single();
      ptoVta = lRow?.afip_punto_venta ?? null;
    }
  }
  if (ptoVta == null) {
    return res.status(400).json({ error: 'AFIP_LOCAL_SIN_PUNTO_VENTA', detail: 'El local de esta venta no tiene punto de venta AFIP configurado.' });
  }
  const cbteTipo = Number(body.tipo_comprobante);
  let numero;
  try {
    numero = (await feUltimoAutorizado(credD, ptoVta, cbteTipo)) + 1;
  } catch (err) {
    console.error('[afip-cae] feUltimoAutorizado failed', err.message);
    return res.status(502).json({ error: 'AFIP_GET_LAST_VOUCHER_FAILED', detail: err.message });
  }

  // ── Solicitar CAE ─────────────────────────────────────────────────────
  const today = new Date();
  const yyyymmdd = parseInt(today.toISOString().slice(0, 10).replaceAll('-', ''));
  const importeNeto = Number(body.importe_neto);
  const importeIva = Number(body.importe_iva);
  const importeTotal = Number(body.importe_total);

  // Notas de crédito (tipos 3, 8, 13) requieren referencia a la factura
  // original via CbtesAsoc. El frontend pasa { cbtes_asoc: [{ tipo, pto_vta,
  // nro, cuit }] }.
  const cbteTipoEsNC = [3, 8, 13].includes(cbteTipo);
  const cbtesAsoc = (body.cbtes_asoc && Array.isArray(body.cbtes_asoc) && body.cbtes_asoc.length > 0)
    ? body.cbtes_asoc.map((c) => ({
        tipo: Number(c.tipo),
        ptoVta: Number(c.pto_vta || c.punto_venta || ptoVta),
        nro: Number(c.nro || c.numero),
        cuit: c.cuit ? String(c.cuit) : cred.cuit,
      }))
    : undefined;
  if (cbteTipoEsNC && !cbtesAsoc) {
    return res.status(400).json({ error: 'NC_REQUIERE_CBTES_ASOC', detail: 'Las notas de crédito requieren referencia a la factura original.' });
  }

  let caeResult;
  try {
    caeResult = await feCAESolicitar(credD, {
      ptoVta, cbteTipo,
      concepto: Number(body.concepto),
      docTipo: Number(body.doc_tipo || 99), // 99 = consumidor final
      docNro: Number(body.doc_nro || 0),
      cbteNro: numero,
      fecha: yyyymmdd,
      impTotal: importeTotal, impNeto: importeNeto, impIVA: importeIva, ivaId: 5,
      // Condición IVA del receptor (obligatorio desde 01/09/2026, RG 5616).
      // 5 = Consumidor Final (default POS). El frontend puede overridear.
      condicionIvaReceptorId: Number(body.condicion_iva_receptor || 5),
      cbtesAsoc,
    });
  } catch (err) {
    console.error('[afip-cae] feCAESolicitar failed', err.message);
    // Guardar factura con estado 'rechazada' para auditoría
    await supabase.from('afip_facturas').insert({
      tenant_id: tenantId,
      venta_pos_id: body.venta_pos_id,
      tipo_comprobante: cbteTipo,
      punto_venta: ptoVta,
      numero,
      importe_neto: importeNeto,
      importe_iva: importeIva,
      importe_total: importeTotal,
      concepto: Number(body.concepto),
      doc_tipo: body.doc_tipo || 99,
      doc_nro: body.doc_nro || null,
      cliente_razon_social: body.cliente_razon_social || null,
      estado: 'rechazada',
      rechazo_motivo: err.message,
      request_uuid: body.request_uuid,
      emitida_por: usuarioId,
    });
    return res.status(502).json({ error: 'AFIP_REJECTED', detail: err.message });
  }

  // ── QR fiscal AR ──────────────────────────────────────────────────────
  const qrFiscalUrl = buildQrUrl({
    fechaISO: today.toISOString().slice(0, 10),
    cuit: cred.cuit, ptoVta, tipoCmp: cbteTipo, nroCmp: numero,
    importe: importeTotal, docTipo: Number(body.doc_tipo || 99), docNro: body.doc_nro || '0',
    cae: caeResult.cae,
  });

  // ── INSERT afip_facturas ──────────────────────────────────────────────
  const { data: factura, error: facErr } = await supabase
    .from('afip_facturas')
    .insert({
      tenant_id: tenantId,
      venta_pos_id: body.venta_pos_id,
      tipo_comprobante: cbteTipo,
      punto_venta: ptoVta,
      numero,
      importe_neto: importeNeto,
      importe_iva: importeIva,
      importe_total: importeTotal,
      concepto: Number(body.concepto),
      doc_tipo: body.doc_tipo || 99,
      doc_nro: body.doc_nro || null,
      cliente_razon_social: body.cliente_razon_social || null,
      cae: caeResult.cae,
      cae_vence_at: caeResult.caeVto,
      qr_fiscal_url: qrFiscalUrl,
      estado: 'aprobada',
      request_uuid: body.request_uuid,
      emitida_at: new Date().toISOString(),
      emitida_por: usuarioId,
    })
    .select('id, cae, cae_vence_at, numero, qr_fiscal_url, estado')
    .single();

  if (facErr) {
    console.error('[afip-cae] INSERT factura failed (CAE ya obtenido)', facErr.message, { numero, cae: caeResult.cae });
    // CAE ya fue emitido en AFIP — devolvemos el CAE al cliente igual.
    // Si el INSERT falla, la próxima retry con el mismo request_uuid va a
    // pegarle de nuevo a AFIP (otro numero distinto). Para evitar eso,
    // el cliente debería trackear cuando el server devuelve CAE sin
    // factura_id como "necesita reconciliar manualmente".
    return res.status(200).json({
      factura_id: null,
      cae: caeResult.cae,
      cae_vence_at: caeResult.caeVto,
      numero,
      qr_fiscal_url: qrFiscalUrl,
      estado: 'aprobada',
      warning: 'CAE_EMITIDO_PERO_NO_PERSISTIDO',
      detail: facErr.message,
    });
  }

  return res.status(200).json({
    factura_id: factura.id,
    cae: factura.cae,
    cae_vence_at: factura.cae_vence_at,
    numero: factura.numero,
    qr_fiscal_url: factura.qr_fiscal_url,
    estado: factura.estado,
  });
}
