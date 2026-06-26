// CORS helper para endpoints del bot llamados desde PASE / COMANDA / admin-console.
// Allow-list explícito por origin — la auth JWT mitiga pero validamos
// el Origin igual para reducir superficie.

const ALLOWED_ORIGINS = new Set([
  'https://pase-yndx.vercel.app',
  'https://pase-admin-console.vercel.app',
  'https://comanda-yndx.vercel.app',
  'https://pase-comanda.vercel.app',
  // Apps nuevas del ecosistema Cocina (25-jun-2026)
  'https://habitue.vercel.app',
  'https://mesa-orpin.vercel.app',
  'https://accesos-eight.vercel.app',
  // Localhost para dev
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
]);

// Para previews de Vercel del propio team.
const VERCEL_PREVIEW_REGEX = /^https:\/\/[a-z0-9-]+-lucastomasferrari-cells-projects\.vercel\.app$/;

export function setCorsHeaders(req, res) {
  const origin = req.headers?.origin || '';
  if (ALLOWED_ORIGINS.has(origin) || VERCEL_PREVIEW_REGEX.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
