// ────────────────────────────────────────────────────────────────────────────
// Extractor de LOCAL
//
// Estrategias:
//   A. "Sucursal: <nombre>"      — etiqueta explícita
//   B. "CUIT: <num>"             — más confiable porque mapea 1-1 a un local
//   C. Header del cierre (primer bloque): primera línea no-decorativa que
//      parece un nombre de comercio.
//
// Devolvemos el TEXTO detectado y el CUIT (separado, otro extractor).
// La validación contra DB (¿este local existe en mi tenant?) la hace el
// validator de la capa 3 / la UI, no este extractor.
// ────────────────────────────────────────────────────────────────────────────

import type { CampoDetectado, TokenizedDoc } from '../types';
import { bloqueOTodo, normalizar } from '../tokenizer';

interface Estrategia<T> {
  fuente: string;
  ejecutar(texto: string): { valor: T; raw: string } | null;
}

// ── Nombre del local ──────────────────────────────────────────────────────

const ESTRATEGIAS_NOMBRE: Estrategia<string>[] = [
  {
    fuente: 'campo "Sucursal:"',
    ejecutar(texto) {
      const m = texto.match(/Sucursal\s*:\s*(.+)/i);
      if (!m || !m[1]) return null;
      const v = m[1].trim().replace(/\s{2,}/g, ' ');
      if (!v) return null;
      return { valor: v, raw: m[0].trim() };
    },
  },
  {
    fuente: 'campo "Local:"',
    ejecutar(texto) {
      const m = texto.match(/^\s*Local\s*:\s*(.+)$/im);
      if (!m || !m[1]) return null;
      const v = m[1].trim().replace(/\s{2,}/g, ' ');
      if (!v) return null;
      return { valor: v, raw: m[0].trim() };
    },
  },
  {
    fuente: 'primera línea con texto significativo',
    ejecutar(texto) {
      // Toma la primera línea de >3 caracteres que no sea decorativa,
      // un campo etiquetado, una fecha, ni un total.
      const lineas = texto.split('\n').map(l => l.trim()).filter(Boolean);
      for (const l of lineas) {
        if (/^[=~\-·•*_]+$/.test(l)) continue;
        if (/^[\d/\-\s]+$/.test(l)) continue;
        const norm = normalizar(l);
        if (norm.startsWith('cierre')) continue;
        if (norm.startsWith('turno')) continue;
        if (norm.startsWith('fecha')) continue;
        if (norm.startsWith('cuit')) continue;
        if (norm.startsWith('apertura')) continue;
        if (norm.startsWith('total')) continue;
        if (norm.startsWith('subtotal')) continue;
        if (norm.includes('forma de cobro')) continue;
        if (norm.includes('forma de pago')) continue;
        if (l.length < 3 || l.length > 80) continue;
        return { valor: l, raw: l };
      }
      return null;
    },
  },
];

// ── CUIT ──────────────────────────────────────────────────────────────────

const ESTRATEGIAS_CUIT: Estrategia<string>[] = [
  {
    fuente: 'campo "CUIT:"',
    ejecutar(texto) {
      // CUIT: 30-12345678-9  o  CUIT: 30123456789
      const m = texto.match(/CUIT\s*:?\s*([\d\-.\s]{11,15})/i);
      if (!m || !m[1]) return null;
      const digits = m[1].replace(/\D/g, '');
      if (digits.length !== 11) return null;
      return { valor: digits, raw: m[0].trim() };
    },
  },
];

function combinar<T>(
  evidencias: Array<{ fuente: string; valor: T; raw: string }>,
  ordenPrioridad: string[],
  notaSiUnica: string | null,
): CampoDetectado<T> {
  if (evidencias.length === 0) {
    return { valor: null, fuente: null, confianza: 'ausente', evidencias: [], nota: notaSiUnica };
  }
  evidencias.sort((a, b) => ordenPrioridad.indexOf(a.fuente) - ordenPrioridad.indexOf(b.fuente));
  const ganador = evidencias[0]!;
  const otros = evidencias.slice(1);
  const iguales = evidencias.every(e => JSON.stringify(e.valor) === JSON.stringify(ganador.valor));
  let confianza: CampoDetectado<T>['confianza'];
  let nota: string | null = null;
  if (iguales && evidencias.length >= 2) confianza = 'alta';
  else if (iguales) confianza = 'media';
  else {
    confianza = 'media';
    const dist = evidencias.filter(e => JSON.stringify(e.valor) !== JSON.stringify(ganador.valor));
    nota = `Discrepancia: ${dist.map(d => `${d.fuente} → ${JSON.stringify(d.valor)}`).join('; ')}. Gana ${ganador.fuente}.`;
  }
  return { valor: ganador.valor, fuente: ganador.fuente, confianza, evidencias: [ganador, ...otros], nota };
}

function ejecutarTodo<T>(t: TokenizedDoc, estrategias: Estrategia<T>[]): Array<{ fuente: string; valor: T; raw: string }> {
  const fuentesTexto = [bloqueOTodo(t, 'header'), t.raw];
  const evidencias: Array<{ fuente: string; valor: T; raw: string }> = [];
  const seen = new Set<string>();
  for (const txt of fuentesTexto) {
    for (const e of estrategias) {
      const r = e.ejecutar(txt);
      if (!r) continue;
      if (seen.has(e.fuente)) continue;
      seen.add(e.fuente);
      evidencias.push({ fuente: e.fuente, valor: r.valor, raw: r.raw });
    }
  }
  return evidencias;
}

export function extractLocalNombre(t: TokenizedDoc): CampoDetectado<string> {
  const ev = ejecutarTodo(t, ESTRATEGIAS_NOMBRE);
  return combinar(ev, [
    'campo "Sucursal:"',
    'campo "Local:"',
    'primera línea con texto significativo',
  ], 'No se detectó nombre del local.');
}

export function extractCuit(t: TokenizedDoc): CampoDetectado<string> {
  const ev = ejecutarTodo(t, ESTRATEGIAS_CUIT);
  return combinar(ev, ['campo "CUIT:"'], null);
}
