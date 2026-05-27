// /api/afip-cae — emisión de CAE (factura electrónica AR) via AFIP WSFEv1.
//
// Flujo:
//   1. Valida JWT del user (tenant_id derivado).
//   2. Idempotency: si vino p_request_uuid y ya hay factura con ese uuid,
//      devuelve el CAE cacheado (sin pegarle de nuevo a AFIP).
//   3. Lee credenciales del tenant (cert + key, solo accesible vía service_role).
//   4. Inicializa @afipsdk/afip.js con cert/key/ambiente.
//   5. getLastVoucher → numero = ultimo + 1.
//   6. createVoucher → CAE.
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
import { Afip } from '@afipsdk/afip.js';
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

  // ── Inicializar SDK ───────────────────────────────────────────────────
  let afip;
  try {
    afip = new Afip({
      CUIT: cred.cuit,
      cert: cred.cert_pem,
      key: cred.key_pem,
      production: cred.ambiente === 'produccion',
      // Token cache: AFIPSDK cachea WSAA tokens 12h por default. Cuando
      // corremos en serverless cold-start, el cache no persiste — c/ invocación
      // saca nuevo token. Aceptable para volúmenes <10/min. Si después escala,
      // moverse a cache en Supabase Storage o env-var rotativa.
    });
  } catch (err) {
    console.error('[afip-cae] SDK init failed', err.message);
    return res.status(500).json({ error: 'AFIP_SDK_INIT_FAILED', detail: err.message });
  }

  // ── Resolver número de comprobante ────────────────────────────────────
  const ptoVta = cred.punto_venta;
  const cbteTipo = Number(body.tipo_comprobante);
  let numero;
  try {
    const ultimo = await afip.ElectronicBilling.getLastVoucher(ptoVta, cbteTipo);
    numero = (ultimo || 0) + 1;
  } catch (err) {
    console.error('[afip-cae] getLastVoucher failed', err.message);
    return res.status(502).json({ error: 'AFIP_GET_LAST_VOUCHER_FAILED', detail: err.message });
  }

  // ── Solicitar CAE ─────────────────────────────────────────────────────
  const today = new Date();
  const yyyymmdd = parseInt(today.toISOString().slice(0, 10).replaceAll('-', ''));
  const importeNeto = Number(body.importe_neto);
  const importeIva = Number(body.importe_iva);
  const importeTotal = Number(body.importe_total);

  const ivaArray = importeIva > 0 ? [{
    Id: 5, // 21% — para Monotributo + RI con tasa estándar
    BaseImp: importeNeto,
    Importe: importeIva,
  }] : undefined;

  // Notas de crédito (tipos 3, 8, 13) requieren referencia a la factura
  // original via CbtesAsoc. El frontend pasa { cbtes_asoc: [{ tipo, pto_vta,
  // nro, cuit }] } y nosotros lo convertimos al shape que espera AFIPSDK.
  const cbteTipoEsNC = [3, 8, 13].includes(cbteTipo);
  const cbtesAsoc = (body.cbtes_asoc && Array.isArray(body.cbtes_asoc) && body.cbtes_asoc.length > 0)
    ? body.cbtes_asoc.map((c) => ({
        Tipo: Number(c.tipo),
        PtoVta: Number(c.pto_vta || c.punto_venta || ptoVta),
        Nro: Number(c.nro || c.numero),
        Cuit: c.cuit ? String(c.cuit) : cred.cuit,
      }))
    : undefined;
  if (cbteTipoEsNC && !cbtesAsoc) {
    return res.status(400).json({ error: 'NC_REQUIERE_CBTES_ASOC', detail: 'Las notas de crédito requieren referencia a la factura original.' });
  }

  let caeResult;
  try {
    caeResult = await afip.ElectronicBilling.createVoucher({
      CantReg: 1,
      PtoVta: ptoVta,
      CbteTipo: cbteTipo,
      Concepto: Number(body.concepto),
      DocTipo: Number(body.doc_tipo || 99), // 99 = consumidor final
      DocNro: Number(body.doc_nro || 0),
      CbteDesde: numero,
      CbteHasta: numero,
      CbteFch: yyyymmdd,
      ImpTotal: importeTotal,
      ImpTotConc: 0,
      ImpNeto: importeNeto,
      ImpOpEx: 0,
      ImpIVA: importeIva,
      ImpTrib: 0,
      MonId: 'PES',
      MonCotiz: 1,
      ...(ivaArray ? { Iva: ivaArray } : {}),
      ...(cbtesAsoc ? { CbtesAsoc: cbtesAsoc } : {}),
    });
  } catch (err) {
    console.error('[afip-cae] createVoucher failed', err.message);
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
  const qrPayload = Buffer.from(JSON.stringify({
    ver: 1,
    fecha: today.toISOString().slice(0, 10),
    cuit: parseInt(cred.cuit),
    ptoVta,
    tipoCmp: cbteTipo,
    nroCmp: numero,
    importe: importeTotal,
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: Number(body.doc_tipo || 99),
    nroDocRec: parseInt(body.doc_nro || '0'),
    tipoCodAut: 'E',
    codAut: parseInt(caeResult.CAE),
  })).toString('base64');
  const qrFiscalUrl = `https://www.afip.gob.ar/fe/qr/?p=${qrPayload}`;

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
      cae: caeResult.CAE,
      cae_vence_at: caeResult.CAEFchVto,
      qr_fiscal_url: qrFiscalUrl,
      estado: 'aprobada',
      request_uuid: body.request_uuid,
      emitida_at: new Date().toISOString(),
      emitida_por: usuarioId,
    })
    .select('id, cae, cae_vence_at, numero, qr_fiscal_url, estado')
    .single();

  if (facErr) {
    console.error('[afip-cae] INSERT factura failed (CAE ya obtenido)', facErr.message, { numero, cae: caeResult.CAE });
    // CAE ya fue emitido en AFIP — devolvemos el CAE al cliente igual.
    // Si el INSERT falla, la próxima retry con el mismo request_uuid va a
    // pegarle de nuevo a AFIP (otro numero distinto). Para evitar eso,
    // el cliente debería trackear cuando el server devuelve CAE sin
    // factura_id como "necesita reconciliar manualmente".
    return res.status(200).json({
      factura_id: null,
      cae: caeResult.CAE,
      cae_vence_at: caeResult.CAEFchVto,
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
