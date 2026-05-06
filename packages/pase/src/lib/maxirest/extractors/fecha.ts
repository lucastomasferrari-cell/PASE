// ────────────────────────────────────────────────────────────────────────────
// Extractor de FECHA
//
// Estrategias:
//   A. "<DiaSemana> <D> de <Mes> de <YYYY>"  — formato Maxirest típico
//   B. DD/MM/YYYY o DD-MM-YYYY                — formato fecha numérica
//   C. YYYY-MM-DD ISO                         — improbable pero seguro
//
// Validación: la fecha NO debe ser futura. Si lo es, queda con warning
// crítico en validators.
// ────────────────────────────────────────────────────────────────────────────

import type { CampoDetectado, TokenizedDoc } from '../types';
import { bloqueOTodo, normalizar } from '../tokenizer';

const MESES_ES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

function pad2(n: number): string { return String(n).padStart(2, '0'); }

function aIso(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

interface Estrategia {
  fuente: string;
  ejecutar(texto: string): { valor: string; raw: string } | null;
}

const ESTRATEGIAS: Estrategia[] = [
  {
    fuente: 'fecha en texto (D de Mes de YYYY)',
    ejecutar(texto) {
      // Ej: "Lunes 4 de Mayo de 2026"  o  "4 de mayo de 2026" (sin día semana)
      const m = texto.match(/(?:\b\w+\s+)?(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i);
      if (!m || !m[1] || !m[2] || !m[3]) return null;
      const mesNorm = normalizar(m[2]);
      const mes = MESES_ES[mesNorm];
      if (!mes) return null;
      const iso = aIso(parseInt(m[3], 10), mes, parseInt(m[1], 10));
      return iso ? { valor: iso, raw: m[0] } : null;
    },
  },
  {
    fuente: 'fecha numérica DD/MM/YYYY',
    ejecutar(texto) {
      // Acepta separador / o -.
      const m = texto.match(/\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})\b/);
      if (!m || !m[1] || !m[2] || !m[3]) return null;
      const yRaw = parseInt(m[3], 10);
      const y = m[3].length === 2 ? 2000 + yRaw : yRaw;
      const iso = aIso(y, parseInt(m[2], 10), parseInt(m[1], 10));
      return iso ? { valor: iso, raw: m[0] } : null;
    },
  },
  {
    fuente: 'fecha ISO YYYY-MM-DD',
    ejecutar(texto) {
      const m = texto.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
      if (!m || !m[1] || !m[2] || !m[3]) return null;
      const iso = aIso(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
      return iso ? { valor: iso, raw: m[0] } : null;
    },
  },
];

export function extractFecha(t: TokenizedDoc): CampoDetectado<string> {
  // La fecha vive en el header; si no, se busca en todo el doc.
  const fuentesTexto = [bloqueOTodo(t, 'header'), t.raw];
  const evidencias: Array<{ fuente: string; valor: string; raw: string }> = [];
  const seen = new Set<string>();

  for (const txt of fuentesTexto) {
    for (const e of ESTRATEGIAS) {
      const r = e.ejecutar(txt);
      if (!r) continue;
      if (seen.has(e.fuente)) continue;
      seen.add(e.fuente);
      evidencias.push({ fuente: e.fuente, valor: r.valor, raw: r.raw });
    }
  }

  if (evidencias.length === 0) {
    return {
      valor: null, fuente: null, confianza: 'ausente',
      evidencias: [], nota: 'No se detectó fecha. Cargala manualmente.',
    };
  }

  // Prioridad: texto > numérica > ISO. (El texto es más resistente a
  // ambigüedad MM/DD vs DD/MM.)
  const orden = [
    'fecha en texto (D de Mes de YYYY)',
    'fecha numérica DD/MM/YYYY',
    'fecha ISO YYYY-MM-DD',
  ];
  evidencias.sort((a, b) => orden.indexOf(a.fuente) - orden.indexOf(b.fuente));
  const ganador = evidencias[0]!;
  const otros = evidencias.slice(1);

  // ¿Coinciden todas?
  const todosIguales = evidencias.every(e => e.valor === ganador.valor);
  let confianza: CampoDetectado<string>['confianza'] = 'media';
  let nota: string | null = null;

  if (todosIguales) {
    confianza = evidencias.length >= 2 ? 'alta' : 'media';
  } else {
    confianza = 'media';
    const distintos = evidencias.filter(e => e.valor !== ganador.valor);
    nota = `Discrepancia entre fuentes: ${distintos.map(d => `${d.fuente} → ${d.valor}`).join('; ')}. Gana ${ganador.fuente}.`;
  }

  return {
    valor: ganador.valor, fuente: ganador.fuente, confianza,
    evidencias: [ganador, ...otros], nota,
  };
}
