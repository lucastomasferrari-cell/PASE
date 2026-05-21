// Cliente de Anthropic para llamar Claude.
//
// Sprint B: respuesta simple sin tools. Sprint C agrega tool calling
// con loop hasta respuesta final.
//
// Modelo default: Haiku 4.6 — barato (~$1 USD / 1M tokens input) y rápido.
// Suficiente para 99% de DMs. Si Lucas necesita razonamiento más fuerte
// (ej. reserva compleja) puede pasar a Sonnet por tenant en `ig_config.modelo`.

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
 * @param {string} opts.modelo - default 'claude-haiku-4-6'
 * @param {number} opts.maxTokens - default 1024
 * @returns {Promise<{texto: string, tokens_in: number, tokens_out: number, costo_usd: number, stop_reason: string}>}
 */
export async function llamarClaude({
  systemPrompt,
  messages,
  modelo = 'claude-haiku-4-6',
  maxTokens = 1024,
}) {
  const resp = await anthropic.messages.create({
    model: modelo,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });

  // El response.content puede ser un array de blocks. Para Sprint B
  // (sin tools) solo nos interesa el texto.
  const textBlock = resp.content.find((b) => b.type === 'text');
  const texto = textBlock?.text || '';

  const tokens_in = resp.usage?.input_tokens || 0;
  const tokens_out = resp.usage?.output_tokens || 0;

  // Costo estimado (Haiku 4.6 pricing): $1/M input + $5/M output (aprox).
  // Ajustar si cambia el pricing.
  const PRECIO_INPUT_PER_MTOK = modelo.includes('haiku') ? 1.0 : modelo.includes('sonnet') ? 3.0 : 15.0;
  const PRECIO_OUTPUT_PER_MTOK = modelo.includes('haiku') ? 5.0 : modelo.includes('sonnet') ? 15.0 : 75.0;
  const costo_usd =
    (tokens_in / 1_000_000) * PRECIO_INPUT_PER_MTOK +
    (tokens_out / 1_000_000) * PRECIO_OUTPUT_PER_MTOK;

  return {
    texto,
    tokens_in,
    tokens_out,
    costo_usd,
    stop_reason: resp.stop_reason,
  };
}
