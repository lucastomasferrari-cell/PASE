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

// Sonnet 4.6 — 5x más barato que Opus 4.7 ($3/$15 vs $15/$75 per M tokens).
// Para chat de soporte tipo "¿cómo cargo un adelanto?" alcanza perfecto.
// Decisión Lucas 2026-05-20 para bajar gasto.
const DEFAULT_MODEL_SOPORTE = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS_SOPORTE = 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await checkUserAuth(req, res);
  if (!auth) return; // checkUserAuth ya envió 401/403/500

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
