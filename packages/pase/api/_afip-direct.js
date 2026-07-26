// Conexión DIRECTA a ARCA (ex-AFIP) — WSAA + WSFEv1, sin terceros.
// Reemplaza a @afipsdk/afip.js (que ruteaba por app.afipsdk.com, de pago/401).
//
// - WSAA: firma un TRA (CMS/PKCS#7 con node-forge) → token+sign (válido 12h).
//   Cache en módulo por CUIT (sirve para invocaciones "warm"; en cold-start
//   re-loguea, igual que hacía AfipSDK). TODO: cache persistente en DB.
// - WSFEv1: FECompUltimoAutorizado (último número) + FECAESolicitar (CAE).
//   Incluye CondicionIVAReceptorId (obligatorio desde 01/09/2026, RG 5616).
//
// Nota TLS: ARCA usa DH de 1024 bits → OpenSSL 3 lo rechaza
// (ERR_SSL_DH_KEY_TOO_SMALL). Usamos un https.Agent con SECLEVEL=1.

import https from 'node:https';
import forgePkg from 'node-forge';
const forge = forgePkg.default ?? forgePkg;

const agent = new https.Agent({ ciphers: 'DEFAULT@SECLEVEL=1', minVersion: 'TLSv1.2' });

const URLS = {
  produccion: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
  },
  testing: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  },
};

// Cache de TA (token/sign) en memoria del módulo, por CUIT+ambiente.
const taCache = new Map();

function soapPost(url, body, soapAction) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
      agent,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': soapAction,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const xesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pick = (xml, tag) => (xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1];

function buildTRA(service) {
  const now = Date.now();
  const gen = new Date(now - 5 * 60 * 1000).toISOString();
  const exp = new Date(now + 10 * 60 * 1000).toISOString();
  const uid = Math.floor(now / 1000);
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0"><header><uniqueId>${uid}</uniqueId><generationTime>${gen}</generationTime><expirationTime>${exp}</expirationTime></header><service>${service}</service></loginTicketRequest>`;
}

function signCMS(traXml, certPem, keyPem) {
  const cert = forge.pki.certificateFromPem(certPem);
  const key = forge.pki.privateKeyFromPem(keyPem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(traXml, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

// Devuelve { token, sign }. Cachea 12h (con margen de 10min).
export async function getTA({ certPem, keyPem, cuit, ambiente }) {
  const key = `${cuit}|${ambiente}`;
  const cached = taCache.get(key);
  if (cached && cached.exp > Date.now() + 10 * 60 * 1000) return { token: cached.token, sign: cached.sign };

  const urls = URLS[ambiente === 'produccion' ? 'produccion' : 'testing'];
  const cms = signCMS(buildTRA('wsfe'), certPem, keyPem);
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;
  const r = await soapPost(urls.wsaa, soap, '');
  const decoded = r.text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const token = pick(decoded, 'token');
  const sign = pick(decoded, 'sign');
  if (!token || !sign) {
    const fault = pick(r.text, 'faultstring') || r.text.slice(0, 300);
    throw new Error('WSAA_FALLO: ' + fault);
  }
  taCache.set(key, { token, sign, exp: Date.now() + 12 * 60 * 60 * 1000 });
  return { token, sign };
}

function authBlock(token, sign, cuit) {
  return `<ar:Auth><ar:Token>${token}</ar:Token><ar:Sign>${sign}</ar:Sign><ar:Cuit>${cuit}</ar:Cuit></ar:Auth>`;
}

export async function feUltimoAutorizado({ certPem, keyPem, cuit, ambiente }, ptoVta, cbteTipo) {
  const { token, sign } = await getTA({ certPem, keyPem, cuit, ambiente });
  const urls = URLS[ambiente === 'produccion' ? 'produccion' : 'testing'];
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/"><soapenv:Body><ar:FECompUltimoAutorizado>${authBlock(token, sign, cuit)}<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo></ar:FECompUltimoAutorizado></soapenv:Body></soapenv:Envelope>`;
  const r = await soapPost(urls.wsfe, soap, 'http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado');
  const nro = pick(r.text, 'CbteNro');
  if (nro == null) throw new Error('FE_ULTIMO_FALLO: ' + (pick(r.text, 'Msg') || pick(r.text, 'faultstring') || r.text.slice(0, 300)));
  return Number(nro);
}

// Solicita CAE para UN comprobante. params:
//  ptoVta, cbteTipo, concepto, docTipo, docNro, cbteNro, fecha(yyyymmdd),
//  impTotal, impNeto, impIVA, ivaId, condicionIvaReceptorId, cbtesAsoc[]
// Devuelve { cae, caeVto, numero } o lanza Error con el detalle de AFIP.
export async function feCAESolicitar(cred, p) {
  const { token, sign } = await getTA(cred);
  const urls = URLS[cred.ambiente === 'produccion' ? 'produccion' : 'testing'];

  const ivaXml = p.impIVA > 0
    ? `<ar:Iva><ar:AlicIva><ar:Id>${p.ivaId || 5}</ar:Id><ar:BaseImp>${p.impNeto}</ar:BaseImp><ar:Importe>${p.impIVA}</ar:Importe></ar:AlicIva></ar:Iva>`
    : '';
  const cbtesAsocXml = (p.cbtesAsoc && p.cbtesAsoc.length)
    ? `<ar:CbtesAsoc>${p.cbtesAsoc.map((c) => `<ar:CbteAsoc><ar:Tipo>${c.tipo}</ar:Tipo><ar:PtoVta>${c.ptoVta}</ar:PtoVta><ar:Nro>${c.nro}</ar:Nro><ar:Cuit>${c.cuit}</ar:Cuit></ar:CbteAsoc>`).join('')}</ar:CbtesAsoc>`
    : '';
  // Orden de elementos EXACTO según WSDL FEV1 (AFIP es estricto).
  const det = `<ar:FECAEDetRequest>` +
    `<ar:Concepto>${p.concepto}</ar:Concepto>` +
    `<ar:DocTipo>${p.docTipo}</ar:DocTipo>` +
    `<ar:DocNro>${p.docNro}</ar:DocNro>` +
    `<ar:CbteDesde>${p.cbteNro}</ar:CbteDesde>` +
    `<ar:CbteHasta>${p.cbteNro}</ar:CbteHasta>` +
    `<ar:CbteFch>${p.fecha}</ar:CbteFch>` +
    `<ar:ImpTotal>${p.impTotal}</ar:ImpTotal>` +
    `<ar:ImpTotConc>0</ar:ImpTotConc>` +
    `<ar:ImpNeto>${p.impNeto}</ar:ImpNeto>` +
    `<ar:ImpOpEx>0</ar:ImpOpEx>` +
    `<ar:ImpIVA>${p.impIVA}</ar:ImpIVA>` +
    `<ar:ImpTrib>0</ar:ImpTrib>` +
    `<ar:MonId>PES</ar:MonId>` +
    `<ar:MonCotiz>1</ar:MonCotiz>` +
    `<ar:CondicionIVAReceptorId>${p.condicionIvaReceptorId || 5}</ar:CondicionIVAReceptorId>` +
    cbtesAsocXml +
    ivaXml +
    `</ar:FECAEDetRequest>`;
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/"><soapenv:Body><ar:FECAESolicitar>${authBlock(token, sign, cred.cuit)}<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${p.ptoVta}</ar:PtoVta><ar:CbteTipo>${p.cbteTipo}</ar:CbteTipo></ar:FeCabReq><ar:FeDetReq>${det}</ar:FeDetReq></ar:FeCAEReq></ar:FECAESolicitar></soapenv:Body></soapenv:Envelope>`;

  const r = await soapPost(urls.wsfe, soap, 'http://ar.gov.afip.dif.FEV1/FECAESolicitar');
  const resultado = pick(r.text, 'Resultado'); // A = aprobado, R = rechazado
  const cae = pick(r.text, 'CAE');
  const caeVto = pick(r.text, 'CAEFchVto');
  // Errores / observaciones (para diagnóstico).
  const obs = [...r.text.matchAll(/<Obs>[\s\S]*?<Code>(\d+)<\/Code>[\s\S]*?<Msg>([\s\S]*?)<\/Msg>[\s\S]*?<\/Obs>/g)].map((m) => `${m[1]}: ${m[2]}`);
  const errs = [...r.text.matchAll(/<Err>[\s\S]*?<Code>(\d+)<\/Code>[\s\S]*?<Msg>([\s\S]*?)<\/Msg>[\s\S]*?<\/Err>/g)].map((m) => `${m[1]}: ${m[2]}`);

  if (resultado !== 'A' || !cae) {
    const detalle = [...errs, ...obs].join(' | ') || pick(r.text, 'faultstring') || r.text.slice(0, 400);
    throw new Error('AFIP_RECHAZO: ' + detalle);
  }
  return { cae, caeVto, numero: p.cbteNro, observaciones: obs };
}

// QR fiscal AR (Res. Gral. 4892/2020).
export function buildQrUrl({ fechaISO, cuit, ptoVta, tipoCmp, nroCmp, importe, docTipo, docNro, cae }) {
  const payload = Buffer.from(JSON.stringify({
    ver: 1, fecha: fechaISO, cuit: parseInt(cuit), ptoVta, tipoCmp, nroCmp,
    importe, moneda: 'PES', ctz: 1, tipoDocRec: Number(docTipo), nroDocRec: parseInt(docNro || '0'),
    tipoCodAut: 'E', codAut: parseInt(cae),
  })).toString('base64');
  return `https://www.afip.gob.ar/fe/qr/?p=${payload}`;
}
