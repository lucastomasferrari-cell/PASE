// ────────────────────────────────────────────────────────────────────────────
// Extractor de horas de APERTURA / CIERRE y NÚMERO DE CIERRE / CUBIERTOS
//
// Estos son extractores chicos, juntos en este archivo para no fragmentar
// demasiado. Comparten patrón "etiqueta + valor" y son lookups directos.
// ────────────────────────────────────────────────────────────────────────────

import type { CampoDetectado, TokenizedDoc } from '../types';
import { bloqueOTodo } from '../tokenizer';

function buscarHora(texto: string, etiqueta: RegExp): { valor: string; raw: string } | null {
  const re = new RegExp(`${etiqueta.source}\\s*:?\\s*(\\d{1,2}):(\\d{2})`, etiqueta.flags);
  const m = texto.match(re);
  if (!m || !m[1] || !m[2]) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(mm) || h > 23 || mm > 59) return null;
  return { valor: `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, raw: m[0] };
}

function envolver<T>(
  fuente: string, valor: T | null, raw: string | null,
): CampoDetectado<T> {
  if (valor == null) return { valor: null, fuente: null, confianza: 'ausente', evidencias: [], nota: null };
  return {
    valor, fuente, confianza: 'alta',
    evidencias: [{ fuente, valor, raw: raw ?? '' }], nota: null,
  };
}

export function extractHoraApertura(t: TokenizedDoc): CampoDetectado<string> {
  const txt = bloqueOTodo(t, 'header');
  const r = buscarHora(txt, /Apertura/i);
  if (r) return envolver('campo "Apertura:"', r.valor, r.raw);
  const r2 = buscarHora(t.raw, /Apertura/i);
  return r2 ? envolver('campo "Apertura:"', r2.valor, r2.raw) : envolver<string>('—', null, null);
}

export function extractHoraCierre(t: TokenizedDoc): CampoDetectado<string> {
  const txt = bloqueOTodo(t, 'header');
  const r = buscarHora(txt, /Cierre/i);
  if (r) return envolver('campo "Cierre:"', r.valor, r.raw);
  const r2 = buscarHora(t.raw, /Cierre/i);
  return r2 ? envolver('campo "Cierre:"', r2.valor, r2.raw) : envolver<string>('—', null, null);
}

export function extractCierreNumero(t: TokenizedDoc): CampoDetectado<number> {
  const txt = bloqueOTodo(t, 'header');
  // Cierre n° 326  /  Cierre Caja n 326  /  Cierre número 326
  const m = txt.match(/Cierre[^\n]*?(?:n[°º]?|nro\.?|n[uú]mero)\s*:?\s*(\d{1,7})/i)
       ?? t.raw.match(/Cierre[^\n]*?(?:n[°º]?|nro\.?|n[uú]mero)\s*:?\s*(\d{1,7})/i);
  if (!m || !m[1]) return { valor: null, fuente: null, confianza: 'ausente', evidencias: [], nota: null };
  const n = parseInt(m[1], 10);
  if (Number.isNaN(n)) return { valor: null, fuente: null, confianza: 'ausente', evidencias: [], nota: null };
  return {
    valor: n, fuente: 'campo "Cierre n°"', confianza: 'alta',
    evidencias: [{ fuente: 'campo "Cierre n°"', valor: n, raw: m[0] }], nota: null,
  };
}

export function extractCubiertos(t: TokenizedDoc): CampoDetectado<number> {
  // "Cubiertos: 23"  o  "Cubiertos Mediodía: 23" / "Cubiertos Noche: 23"
  // Tomamos cualquier match de cubiertos seguido de número.
  const txt = t.raw;
  const m = txt.match(/Cubiertos(?:\s+(?:Mediod[ií]a|Noche))?\s*:?\s*(\d{1,4})\b/i);
  if (!m || !m[1]) return { valor: null, fuente: null, confianza: 'ausente', evidencias: [], nota: null };
  const n = parseInt(m[1], 10);
  if (Number.isNaN(n)) return { valor: null, fuente: null, confianza: 'ausente', evidencias: [], nota: null };
  return {
    valor: n, fuente: 'campo "Cubiertos"', confianza: 'alta',
    evidencias: [{ fuente: 'campo "Cubiertos"', valor: n, raw: m[0] }], nota: null,
  };
}
