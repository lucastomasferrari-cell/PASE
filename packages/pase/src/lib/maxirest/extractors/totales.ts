// ────────────────────────────────────────────────────────────────────────────
// Extractor de TOTALES (ingresos / egresos / saldo de caja)
//
// Estrategia:
// - Buscar etiquetas semánticas + número en la sección "totales".
// - Si la sección no se detectó, buscar en raw.
// - El número puede venir con $ y formato AR (1.234,56) o mixto.
//
// Validación cruzada (en validators.ts): ingresos - egresos = saldo.
// ────────────────────────────────────────────────────────────────────────────

import type { CampoDetectado, TokenizedDoc } from '../types';
import { bloqueOTodo } from '../tokenizer';

/** Convierte string AR ("$1.234,56" o "1234.56") a número. */
export function parseMontoAR(raw: string): number | null {
  if (!raw) return null;
  // Sacar $, espacios, NBSP. Conservar dígitos, coma, punto y signo.
  let s = raw.replace(/[$\s\u00a0]/g, '');
  if (!s) return null;
  // Si hay coma decimal y punto separador miles → quitar puntos y cambiar coma por punto.
  // Si solo hay punto decimal → dejar.
  // Heurística simple: si la última coma está después del último punto → coma es decimal.
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0 && lastDot < 0) {
    // Solo coma → asumir decimal.
    s = s.replace(',', '.');
  }
  // En este punto s solo debería tener un punto decimal y un signo opcional.
  s = s.replace(/[^\d.-]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

interface Etiqueta {
  fuente: string;
  patrones: RegExp[];
}

const ETIQUETAS: Record<'ingresos' | 'egresos' | 'saldo', Etiqueta> = {
  ingresos: {
    fuente: 'etiqueta ingresos',
    patrones: [
      /(?:Subtotal\s+Ingresos|Total\s+Ingresos|Ingresos\s+Totales|Ingresos\s+del\s+Cierre)\s*:?\s*\$?\s*([\d.,\u00a0\s-]+)/i,
    ],
  },
  egresos: {
    fuente: 'etiqueta egresos',
    patrones: [
      /(?:Subtotal\s+Egresos|Total\s+Egresos|Egresos\s+Totales|Egresos\s+del\s+Cierre)\s*:?\s*\$?\s*([\d.,\u00a0\s-]+)/i,
    ],
  },
  saldo: {
    fuente: 'etiqueta saldo',
    patrones: [
      /(?:Saldo\s+de\s+Caja|Saldo\s+del\s+Cierre|Saldo\s+Final|Total\s+Caja)\s*:?\s*\$?\s*([\d.,\u00a0\s-]+)/i,
    ],
  },
};

function buscar(texto: string, etiqueta: Etiqueta): { valor: number; raw: string } | null {
  for (const p of etiqueta.patrones) {
    const m = texto.match(p);
    if (!m || !m[1]) continue;
    const n = parseMontoAR(m[1]);
    if (n == null) continue;
    return { valor: n, raw: m[0].slice(0, 80) };
  }
  return null;
}

function envolverTotal(fuente: string, valor: number | null, raw: string | null): CampoDetectado<number> {
  if (valor == null) return { valor: null, fuente: null, confianza: 'ausente', evidencias: [], nota: null };
  return {
    valor, fuente, confianza: 'alta',
    evidencias: [{ fuente, valor, raw: raw ?? '' }], nota: null,
  };
}

export function extractTotalIngresos(t: TokenizedDoc): CampoDetectado<number> {
  const txt = bloqueOTodo(t, 'totales');
  const r = buscar(txt, ETIQUETAS.ingresos);
  if (r) return envolverTotal(ETIQUETAS.ingresos.fuente, r.valor, r.raw);
  const r2 = buscar(t.raw, ETIQUETAS.ingresos);
  return r2 ? envolverTotal(ETIQUETAS.ingresos.fuente, r2.valor, r2.raw) : envolverTotal('—', null, null);
}

export function extractTotalEgresos(t: TokenizedDoc): CampoDetectado<number> {
  const txt = bloqueOTodo(t, 'totales');
  const r = buscar(txt, ETIQUETAS.egresos);
  if (r) return envolverTotal(ETIQUETAS.egresos.fuente, r.valor, r.raw);
  const r2 = buscar(t.raw, ETIQUETAS.egresos);
  return r2 ? envolverTotal(ETIQUETAS.egresos.fuente, r2.valor, r2.raw) : envolverTotal('—', null, null);
}

export function extractSaldoCaja(t: TokenizedDoc): CampoDetectado<number> {
  const txt = bloqueOTodo(t, 'totales');
  const r = buscar(txt, ETIQUETAS.saldo);
  if (r) return envolverTotal(ETIQUETAS.saldo.fuente, r.valor, r.raw);
  const r2 = buscar(t.raw, ETIQUETAS.saldo);
  return r2 ? envolverTotal(ETIQUETAS.saldo.fuente, r2.valor, r2.raw) : envolverTotal('—', null, null);
}
