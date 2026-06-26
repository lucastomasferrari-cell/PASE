// Cliente de Anthropic para llamar Claude.
//
// Sprint B: respuesta simple sin tools. Sprint C agrega tool calling
// con loop hasta respuesta final.
//
// Modelo default: Sonnet 4.6 — usado también por PASE para soporte chat.
// Costo aprox $3/M input + $15/M output. Lo bajamos a Haiku cuando salga
// el nombre correcto disponible (claude-haiku-4-6 tira 404 al 2026-05-21).
// Configurable por tenant en `ig_config.modelo`.
//
// AUDIT F6A#5 — PROMPT CACHING (2026-05-27): el system prompt del bot
// (típicamente 800-3000 tokens con info del negocio + menú + horarios +
// memoria del cliente) se repetía en cada llamada y se cobraba a full price.
// Anthropic ofrece cache de 5 min con costo de write 25% más caro pero
// reads a 10% del precio. Resultado neto: ~5x más barato cuando se llama
// múltiples veces en ventana corta (típico durante una conversación).
//
// Cómo activar caching: cache_control en el último system block.
// El cache hit vs miss se reporta en usage.cache_read_input_tokens y
// usage.cache_creation_input_tokens — ambos campos contemplados en el
// costo total para tracking real.

import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  throw new Error('Missing ANTHROPIC_API_KEY in environment');
}

export const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

/**
 * Hace una llamada a Claude con system prompt + mensajes históricos.
 * Devuelve la respuesta final + tracking de tokens.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {Array<{role:'user'|'assistant', content:string}>} opts.messages
 * @param {string} opts.modelo - default 'claude-sonnet-4-6'
 * @param {number} opts.maxTokens - default 1024
 * @returns {Promise<{texto: string, tokens_in: number, tokens_out: number, cache_read: number, cache_write: number, costo_usd: number, stop_reason: string}>}
 */
// Modelos válidos conocidos. Si ig_config.modelo tiene un valor que NO está
// acá (típico: 'claude-haiku-4-6' que da 404 desde 2026-05-21, o cualquier
// nombre viejo/mal tipeado), caemos a sonnet en vez de matar la conversación
// con un 404. Bug real 30-may: @maneki tenía 'claude-haiku-4-6' guardado y
// el bot tiraba "Claude API: 404 model: claude-haiku-4-6" en cada DM →
// nunca respondía. Esta defensa hace que un modelo mal configurado degrade
// elegantemente en vez de romper.
const MODELOS_VALIDOS = new Set([
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-opus-4-7',
  'claude-haiku-4',
]);
const MODELO_FALLBACK = 'claude-sonnet-4-6';

// AUDIT F6A CRIT-4 (2026-05-27): clamps defensivos server-side. Si un dueño
// hostil o un JWT robado hace `UPDATE ig_config SET max_tokens=200000`, sin
// estos topes 1 mensaje cuesta ~$1 USD en Sonnet. Defensa en profundidad:
// además del CHECK constraint en DB (migration 202606250800), clamp acá
// también — un atacante con service_role bypassa RLS pero NO el código.
const MAX_TOKENS_HARD_CAP = 4096;
const SYSTEM_PROMPT_HARD_CAP = 50_000;  // chars (≈ 12.500 tokens)

export async function llamarClaude({
  systemPrompt,
  messages,
  modelo = 'claude-sonnet-4-6',
  maxTokens = 1024,
}) {
  // Normalizar el modelo: si no es uno conocido válido, usar el fallback.
  if (!MODELOS_VALIDOS.has(modelo)) {
    console.warn(`[claude] modelo '${modelo}' no es válido, usando ${MODELO_FALLBACK}`);
    modelo = MODELO_FALLBACK;
  }

  // Clamp defensivo: max_tokens y system_prompt no pueden exceder topes
  // razonables aunque ig_config tenga valores corruptos.
  const maxTokensClamp = Math.min(Math.max(128, Number(maxTokens) || 1024), MAX_TOKENS_HARD_CAP);
  if (maxTokensClamp !== maxTokens) {
    console.warn(`[claude] maxTokens=${maxTokens} clampeado a ${maxTokensClamp}`);
  }
  maxTokens = maxTokensClamp;

  if (typeof systemPrompt === 'string' && systemPrompt.length > SYSTEM_PROMPT_HARD_CAP) {
    console.warn(`[claude] systemPrompt length=${systemPrompt.length} excede ${SYSTEM_PROMPT_HARD_CAP}, truncado`);
    systemPrompt = systemPrompt.slice(0, SYSTEM_PROMPT_HARD_CAP);
  }
  // AUDIT F6A#5: el system prompt va como array con cache_control para
  // que Anthropic lo cachee 5 min. Solo cachea si pesa ≥ 1024 tokens
  // (Sonnet) — más cortos siguen siendo full price (no rompe nada).
  const systemArr = systemPrompt
    ? [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ]
    : undefined;

  const resp = await anthropic.messages.create({
    model: modelo,
    max_tokens: maxTokens,
    system: systemArr,
    messages,
  });

  const textBlock = resp.content.find((b) => b.type === 'text');
  const texto = textBlock?.text || '';

  const tokens_in = resp.usage?.input_tokens || 0;
  const tokens_out = resp.usage?.output_tokens || 0;
  const cache_read = resp.usage?.cache_read_input_tokens || 0;
  const cache_write = resp.usage?.cache_creation_input_tokens || 0;

  // Pricing con cache (Anthropic 2026):
  //   - Cache write: input × 1.25  (más caro la primera vez)
  //   - Cache read:  input × 0.10  (10% del precio normal)
  //   - input/output: normal.
  const PRECIO_INPUT_PER_MTOK = modelo.includes('haiku') ? 1.0 : modelo.includes('sonnet') ? 3.0 : 15.0;
  const PRECIO_OUTPUT_PER_MTOK = modelo.includes('haiku') ? 5.0 : modelo.includes('sonnet') ? 15.0 : 75.0;
  const costo_usd =
    (tokens_in / 1_000_000) * PRECIO_INPUT_PER_MTOK +
    (cache_write / 1_000_000) * PRECIO_INPUT_PER_MTOK * 1.25 +
    (cache_read / 1_000_000) * PRECIO_INPUT_PER_MTOK * 0.10 +
    (tokens_out / 1_000_000) * PRECIO_OUTPUT_PER_MTOK;

  return {
    texto,
    tokens_in,
    tokens_out,
    cache_read,
    cache_write,
    costo_usd,
    stop_reason: resp.stop_reason,
  };
}
