// Proxy a la API de Anthropic Messages para el Lector IA de facturas.
//
// Hasta el sprint del 2026-05-06 este endpoint NO autenticaba al caller —
// cualquiera con la URL podía consumir tokens de Anthropic con la API key
// del server. Ahora exige Authorization: Bearer <supabase_jwt> de un
// usuario activo del tenant. El frontend lo manda automáticamente.

import { checkUserAuth } from './_user-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await checkUserAuth(req, res);
  if (!auth) return; // checkUserAuth ya envió 401/403/500

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(req.body),
  });
  const data = await response.json();
  res.status(response.status).json(data);
}
