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
import { GASTRO_SENSEI_SYSTEM_PROMPT } from './_gastro-sensei-prompt.js';
import { createClient } from '@supabase/supabase-js';

// Pricing por modelo (USD por 1M tokens, según Anthropic public pricing 2026).
// Si Anthropic cambia el pricing, hay que actualizar acá.
const MODEL_PRICING = {
  'claude-opus-4-7':   { in: 15.00, out: 75.00 },
  'claude-sonnet-4-6': {  in: 3.00, out: 15.00 },
  'claude-sonnet-4-5': {  in: 3.00, out: 15.00 },
  'claude-haiku-4':    {  in: 0.80, out:  4.00 },
};

function calcCost(model, tokensIn, tokensOut) {
  const p = MODEL_PRICING[model];
  if (!p) return 0; // modelo desconocido — no cobramos
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

// Cliente service_role para insertar en llm_usage_log (bypassa RLS).
// Lazy: si no hay env vars, el tracking se skipea silenciosamente.
let _trackingClient = null;
function getTrackingClient() {
  if (_trackingClient) return _trackingClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  _trackingClient = createClient(url, key, { auth: { persistSession: false } });
  return _trackingClient;
}

// Guardar tracking en DB. Fire-and-forget (no bloquea response al user).
function trackUsage({ tenantId, usuarioId, task, model, tokensIn, tokensOut }) {
  const client = getTrackingClient();
  if (!client) return;
  const cost = calcCost(model, tokensIn, tokensOut);
  void client.from('llm_usage_log').insert({
    tenant_id: tenantId,
    usuario_id: usuarioId,
    task: task || 'legacy',
    model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: cost,
    source: 'pase-api',
  }).then(({ error }) => {
    if (error) console.warn('[claude] trackUsage falló (no crítico):', error.message);
  });
}

// Sonnet 4.6 — 5x más barato que Opus 4.7 ($3/$15 vs $15/$75 per M tokens).
// Para chat de soporte tipo "¿cómo cargo un adelanto?" alcanza perfecto.
// Decisión Lucas 2026-05-20 para bajar gasto.
const DEFAULT_MODEL_SOPORTE = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS_SOPORTE = 1024;

// AUDIT F6A#6 (2026-05-27): caps server-side para evitar abuso.
// El frontend puede pedir más tokens (ej. Lector Facturas pide 1500), pero
// nunca por encima de estos caps que protegen contra cost-runaway si un
// user manipula el body para pedir max_tokens=200000.
//
// El cap del proxy crudo (task='legacy', sin task definido) es el más
// estricto porque ahí el body es libre. Las tasks armadas server-side
// (soporte-chat / gastro-sensei) tienen sus propios defaults.
const MAX_TOKENS_HARD_CAP = 4096;       // Cualquier task no puede pedir más.
const MAX_TOKENS_LEGACY_CAP = 2000;     // Proxy crudo (Lector Facturas IA).

// Rate limit best-effort en memoria del serverless function. Cada deploy/
// invocación fría lo resetea, pero suficiente para frenar burst de abuso
// dentro de una ventana de 5 min. Para rate limit persistente cross-deploys
// requerimos tabla DB (sprint medio).
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;  // 5 min
const RATE_LIMIT_MAX_CALLS = 30;             // 30 calls / 5 min / user
const callCounts = new Map(); // user_id → [{at}]

function rateLimitCheck(userId) {
  const now = Date.now();
  const arr = (callCounts.get(userId) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= RATE_LIMIT_MAX_CALLS) {
    return { ok: false, count: arr.length, window_ms: RATE_LIMIT_WINDOW_MS };
  }
  arr.push(now);
  callCounts.set(userId, arr);
  return { ok: true, count: arr.length };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await checkUserAuth(req, res);
  if (!auth) return; // checkUserAuth ya envió 401/403/500

  // AUDIT F6A#6: rate limit per-user (best-effort).
  const rl = rateLimitCheck(auth.row.id);
  if (!rl.ok) {
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      detail: `Excediste ${RATE_LIMIT_MAX_CALLS} llamadas a Claude en ${Math.round(RATE_LIMIT_WINDOW_MS / 60000)} min. Esperá un rato.`,
      retry_after_seconds: Math.round(RATE_LIMIT_WINDOW_MS / 1000),
    });
    return;
  }

  // Si el body trae un `task` conocido, armamos el payload server-side.
  // Caso contrario, comportamiento legacy: proxy crudo.
  const body = req.body || {};
  let payload;
  if (body.task === 'soporte-chat') {
    payload = buildSoporteChatPayload(body, auth);
  } else if (body.task === 'gastro-sensei') {
    payload = buildGastroSenseiPayload(body, auth);
  } else {
    payload = body;
  }

  // AUDIT F6A#6: cap max_tokens server-side.
  const isLegacy = !body.task;
  const cap = isLegacy ? MAX_TOKENS_LEGACY_CAP : MAX_TOKENS_HARD_CAP;
  if (payload.max_tokens && payload.max_tokens > cap) {
    console.warn(`[claude proxy] user=${auth.row.id} pidió max_tokens=${payload.max_tokens}, capeado a ${cap}`);
    payload.max_tokens = cap;
  }

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

    // Track usage (fire-and-forget, no bloquea response).
    if (response.ok && data.usage) {
      trackUsage({
        tenantId: auth.row.tenant_id ?? null,
        usuarioId: auth.row.id ?? null,
        task: body.task,
        model: payload.model || 'unknown',
        tokensIn: data.usage.input_tokens || 0,
        tokensOut: data.usage.output_tokens || 0,
      });
    }

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

// Arma el payload para el Gastro-Sensei (análisis de CMV).
//
// El frontend manda:
//   - cmv_resumen: { eficiencia_pct, cmv_real_pct, consumo_real_valor,
//     consumo_teorico_valor, mermas_valor, diferencia_valor, ... }
//   - top_insumos: [{ nombre, diferencia_cantidad, diferencia_valor,
//     unidad, consumo_real_valor, consumo_teorico_valor, ... }] (max 10)
//   - tipo_negocio (opcional): "sushi" | "parrilla" | "pasta" | etc. — el
//     asesor usa benchmarks distintos según tipo.
//   - periodo: { desde, hasta }
//
// El asesor responde con texto plano. Sin streaming (es una sola request).
function buildGastroSenseiPayload(body, auth) {
  const { cmv_resumen, top_insumos, tipo_negocio, periodo } = body;
  if (!cmv_resumen) {
    throw new Error('GASTRO_SENSEI_FALTA_DATA: cmv_resumen requerido');
  }

  // Armamos el user message con la data del CMV en formato compacto.
  const lines = [];
  lines.push(`# Datos del CMV para análisis`);
  if (periodo?.desde) lines.push(`Período: ${periodo.desde} a ${periodo.hasta}`);
  if (tipo_negocio) lines.push(`Tipo de negocio: ${tipo_negocio}`);
  lines.push('');
  lines.push(`## Resumen global`);
  if (cmv_resumen.facturacion) lines.push(`Facturación: $${Math.round(cmv_resumen.facturacion).toLocaleString('es-AR')}`);
  if (cmv_resumen.consumo_teorico_valor) lines.push(`CMV teórico (recetas): $${Math.round(cmv_resumen.consumo_teorico_valor).toLocaleString('es-AR')}`);
  if (cmv_resumen.consumo_real_valor) lines.push(`CMV real (movimientos): $${Math.round(cmv_resumen.consumo_real_valor).toLocaleString('es-AR')}`);
  if (cmv_resumen.cmv_real_pct != null) lines.push(`CMV real % sobre ventas: ${cmv_resumen.cmv_real_pct}%`);
  if (cmv_resumen.cmv_teorico_pct != null) lines.push(`CMV teórico % sobre ventas: ${cmv_resumen.cmv_teorico_pct}%`);
  if (cmv_resumen.eficiencia_pct != null) lines.push(`Eficiencia (teórico/real): ${cmv_resumen.eficiencia_pct}%`);
  if (cmv_resumen.diferencia_valor) {
    const d = cmv_resumen.diferencia_valor;
    lines.push(`Diferencia neta: $${Math.round(d).toLocaleString('es-AR')} (${d < 0 ? 'PÉRDIDA' : 'AHORRO'})`);
  }
  if (cmv_resumen.mermas_valor) lines.push(`Mermas declaradas: $${Math.round(cmv_resumen.mermas_valor).toLocaleString('es-AR')}`);
  if (cmv_resumen.insumos_con_fuga != null) lines.push(`Insumos con fuga detectada: ${cmv_resumen.insumos_con_fuga}`);

  if (Array.isArray(top_insumos) && top_insumos.length > 0) {
    lines.push('');
    lines.push(`## Top insumos con mayor diferencia (ordenados por magnitud)`);
    for (const i of top_insumos.slice(0, 10)) {
      const diffCant = Number(i.diferencia_cantidad ?? 0);
      const diffVal = Number(i.diferencia_valor ?? 0);
      const realVal = Number(i.consumo_real_valor ?? 0);
      const teoricoVal = Number(i.consumo_teorico_valor ?? 0);
      const sign = diffVal < 0 ? '🔻' : '🔼';
      lines.push(
        `- ${sign} ${i.nombre} (${i.unidad}): real ${Number(i.consumo_real_cantidad ?? 0).toFixed(2)} vs teórico ${Number(i.consumo_teorico_cantidad ?? 0).toFixed(2)} | ` +
        `diff ${diffCant > 0 ? '+' : ''}${diffCant.toFixed(2)} ${i.unidad} = $${Math.round(diffVal).toLocaleString('es-AR')} | ` +
        `(real $${Math.round(realVal).toLocaleString('es-AR')} vs teórico $${Math.round(teoricoVal).toLocaleString('es-AR')})`
      );
    }
  }
  lines.push('');
  lines.push(`Analizá estos datos y dame el diagnóstico siguiendo tu formato.`);

  const ctx = body.contexto || {};
  const ctxLines = [];
  const authEmail = auth?.user?.email || auth?.row?.email;
  if (ctx.local_nombre) ctxLines.push(`Local: ${ctx.local_nombre}`);
  if (authEmail) ctxLines.push(`Usuario: ${authEmail}`);

  return {
    model: body.model || 'claude-sonnet-4-6', // Sonnet alcanza para análisis tabular
    max_tokens: body.max_tokens || 1500,
    system: [
      {
        type: 'text',
        text: GASTRO_SENSEI_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
      ...(ctxLines.length > 0 ? [{ type: 'text', text: '## CONTEXTO\n' + ctxLines.join('\n') }] : []),
    ],
    messages: [
      { role: 'user', content: lines.join('\n') },
    ],
  };
}
