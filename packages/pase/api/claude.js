// Proxy a la API de Anthropic Messages.
//
// Soporta 2 modos:
//
//   1. **Legacy (sin `task`)**: proxy crudo del body al endpoint Anthropic.
//      Lo usa el Lector de Facturas (Sprint 5-2026-05-06+). El frontend
//      arma el system prompt completo en el cliente.
//
//   2. **task: 'soporte-chat'** (2026-05-19): el frontend manda solo
//      `messages` (turnos del usuario) y un `contexto` opcional. El server
//      inyecta el system prompt operativo de `_soporte-prompt.js` con
//      cache_control para aprovechar prompt caching de Anthropic.
//
// Auth: el caller manda Authorization: Bearer <supabase_jwt>. Verificamos
// que sea un usuario activo de algún tenant. Sin esto, cualquiera con la
// URL consumiría tokens de Anthropic.

import { checkUserAuth } from './_user-auth.js';
import { SOPORTE_SYSTEM_PROMPT } from './_soporte-prompt.js';

const DEFAULT_MODEL_SOPORTE = 'claude-opus-4-7';
const DEFAULT_MAX_TOKENS_SOPORTE = 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await checkUserAuth(req, res);
  if (!auth) return; // checkUserAuth ya envió 401/403/500

  // Si el body trae task=soporte-chat, armamos el payload server-side.
  // Caso contrario, comportamiento legacy: proxy crudo.
  const body = req.body || {};
  const payload = body.task === 'soporte-chat'
    ? buildSoporteChatPayload(body, auth)
    : body;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'ANTHROPIC_FETCH_FAILED', detail: String(e?.message || e) });
  }
}

// Arma el payload para Anthropic cuando es soporte-chat.
//
// Convenciones:
//   - `messages` viene del cliente con el historial de turns.
//   - `contexto` (opcional) trae { sistema, pantalla, rol, email } que
//     concatenamos al system como contexto adicional. NO entra al cache
//     porque cambia por usuario/pantalla.
//   - El system prompt grande sí entra al cache (cache_control ephemeral).
function buildSoporteChatPayload(body, auth) {
  const ctx = body.contexto || {};
  const systemBlocks = [
    {
      type: 'text',
      text: SOPORTE_SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' },
    },
  ];

  // Bloque de contexto del usuario actual — varía por request, no cachea.
  const ctxLines = [];
  if (ctx.sistema) ctxLines.push(`Sistema: ${ctx.sistema}`);
  if (ctx.pantalla) ctxLines.push(`Pantalla actual: ${ctx.pantalla}`);
  if (ctx.rol) ctxLines.push(`Rol del usuario: ${ctx.rol}`);
  // auth tiene shape { user, row } — el email vive en user.email (Supabase Auth).
  const authEmail = auth?.user?.email || auth?.row?.email;
  if (ctx.email || authEmail) ctxLines.push(`Email del usuario: ${ctx.email || authEmail}`);
  // Si el caller no mandó rol, lo derivamos del JWT (es info confiable).
  if (!ctx.rol && auth?.row?.rol) ctxLines.push(`Rol del usuario (del JWT): ${auth.row.rol}`);
  if (ctx.local_id) ctxLines.push(`Local activo: ${ctx.local_id}`);
  if (ctxLines.length > 0) {
    systemBlocks.push({
      type: 'text',
      text: '## CONTEXTO DE ESTE TURNO\n' + ctxLines.join('\n'),
    });
  }

  return {
    model: body.model || DEFAULT_MODEL_SOPORTE,
    max_tokens: body.max_tokens || DEFAULT_MAX_TOKENS_SOPORTE,
    system: systemBlocks,
    messages: body.messages || [],
  };
}
