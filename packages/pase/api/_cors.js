// CORS helper compartido — allow-list explícito por origin.
//
// Fix auditoría 2026-05-21 ALTO-5: antes los endpoints serverless tenían
// Access-Control-Allow-Origin: * con Authorization aceptado. La auth JWT
// mitiga, pero superficie ampliada: si un JWT se roba en otro front (XSS,
// malware extension), atacante podía pegarle a crear-tenant/afip-cae/etc.
// desde cualquier origin.
//
// Ahora valida el header Origin contra una lista explícita. Si no matchea,
// se omite el header → el browser bloquea la respuesta.
//
// Uso:
//   import { setCorsHeaders } from './_cors.js';
//   export default async function handler(req, res) {
//     setCorsHeaders(req, res);
//     if (req.method === 'OPTIONS') return res.status(204).end();
//     ...
//   }

const ALLOWED_ORIGINS = new Set([
  'https://pase-yndx.vercel.app',
  'https://pase-admin-console.vercel.app',
  'https://pase-instagram-bot.vercel.app',
  'https://pase-comanda.vercel.app',
  // Apps nuevas del ecosistema Cocina (25-jun-2026)
  'https://habitue-ruddy.vercel.app',
  'https://mesa-orpin.vercel.app',
  'https://accesos-eight.vercel.app',
  // Localhost para dev
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
]);

// Para dominios custom que Lucas pueda agregar (ej: pase-admin.lucas.com.ar).
// Detecta cualquier vercel.app del propio team (lucastomasferrari-cells-projects).
const VERCEL_PREVIEW_REGEX = /^https:\/\/[a-z0-9-]+-lucastomasferrari-cells-projects\.vercel\.app$/;

export function setCorsHeaders(req, res) {
  const origin = req.headers?.origin || '';

  if (ALLOWED_ORIGINS.has(origin) || VERCEL_PREVIEW_REGEX.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  // Si no matchea, NO setear el header. Browser bloquea respuesta.

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
