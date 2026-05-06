// ────────────────────────────────────────────────────────────────────────────
// Extractor de TURNO
//
// Estrategias:
//   A. Campo "Turno: <valor>"        — más explícito (confianza alta sola)
//   B. Header "Turno N (X)"          — N=1/2 + nombre opcional + cualquier separador
//   C. Etiqueta "Cubiertos Turno X"  — donde X es mediodía/noche
//   D. Hora de cierre <16:00 = mediodía, ≥16:00 = noche  — fallback (baja)
//
// Combinación:
//   - Si A y B coinciden  → confianza alta
//   - Si A y B difieren   → gana A, warning con la discrepancia
//   - Si solo D matchea   → confianza baja
//   - Si nada matchea     → ausente
// ────────────────────────────────────────────────────────────────────────────

import type { CampoDetectado, TokenizedDoc, TurnoNombre } from '../types';
import { bloqueOTodo, normalizar } from '../tokenizer';

const PALABRA_LETRAS = '[A-Za-zÁÉÍÓÚáéíóúñÑ]+';

function normalizarNombre(s: string): TurnoNombre | null {
  const x = normalizar(s);
  if (x === 'noche') return 'Noche';
  if (x === 'mediodia') return 'Mediodía';
  return null;
}

interface Estrategia {
  fuente: string;
  ejecutar(texto: string): { valor: TurnoNombre; raw: string } | null;
}

const ESTRATEGIAS: Estrategia[] = [
  {
    fuente: 'campo "Turno:"',
    ejecutar(texto) {
      const m = texto.match(new RegExp(`Turno\\s*:\\s*(${PALABRA_LETRAS})`, 'i'));
      if (!m || !m[1]) return null;
      const v = normalizarNombre(m[1]);
      return v ? { valor: v, raw: m[0] } : null;
    },
  },
  {
    fuente: 'header "Turno N (X)"',
    ejecutar(texto) {
      // Acepta: paréntesis, corchetes, llaves, dos puntos, guión, en blanco.
      // \s*[\W_]?\s* permite cualquier no-letra/no-dígito como separador,
      // o nada (caso "Turno 2 Noche" sin separador).
      const m = texto.match(new RegExp(
        `Turno\\s+(\\d+)\\s*[(\\[{:\\-\\s]\\s*(${PALABRA_LETRAS})`, 'i',
      ));
      if (m && m[2]) {
        const v = normalizarNombre(m[2]);
        if (v) return { valor: v, raw: m[0] };
      }
      // Fallback: solo número, sin nombre. 1 → mediodía / 2 → noche.
      const m2 = texto.match(/Turno\s+(\d+)\b/i);
      if (m2 && m2[1]) {
        const n = parseInt(m2[1], 10);
        if (n === 1) return { valor: 'Mediodía', raw: m2[0] };
        if (n === 2) return { valor: 'Noche', raw: m2[0] };
      }
      return null;
    },
  },
  {
    fuente: 'etiqueta "Cubiertos Turno X"',
    ejecutar(texto) {
      const m = texto.match(new RegExp(`Cubiertos\\s+Turno\\s+(${PALABRA_LETRAS})`, 'i'));
      if (!m || !m[1]) return null;
      const v = normalizarNombre(m[1]);
      return v ? { valor: v, raw: m[0] } : null;
    },
  },
  {
    fuente: 'hora de cierre',
    ejecutar(texto) {
      const m = texto.match(/Cierre\s*:?\s*(\d{1,2}):(\d{2})/i);
      if (!m || !m[1]) return null;
      const h = parseInt(m[1], 10);
      if (Number.isNaN(h)) return null;
      const v: TurnoNombre = h < 16 ? 'Mediodía' : 'Noche';
      return { valor: v, raw: m[0] };
    },
  },
];

export function extractTurno(t: TokenizedDoc): CampoDetectado<TurnoNombre> {
  // El header es el lugar más probable para los campos directos. Como
  // fallback, todo el doc.
  const fuentesTexto = [bloqueOTodo(t, 'header'), t.raw];
  const evidencias: Array<{ fuente: string; valor: TurnoNombre; raw: string }> = [];
  const seen = new Set<string>();
  for (const txt of fuentesTexto) {
    for (const e of ESTRATEGIAS) {
      const r = e.ejecutar(txt);
      if (!r) continue;
      const key = e.fuente;
      if (seen.has(key)) continue;
      seen.add(key);
      evidencias.push({ fuente: e.fuente, valor: r.valor, raw: r.raw });
    }
  }

  if (evidencias.length === 0) {
    return {
      valor: null, fuente: null, confianza: 'ausente',
      evidencias: [], nota: 'No se detectó turno en ninguna estrategia.',
    };
  }

  // Prioridad: campo > header > cubiertos > hora.
  const orden = ['campo "Turno:"', 'header "Turno N (X)"', 'etiqueta "Cubiertos Turno X"', 'hora de cierre'];
  evidencias.sort((a, b) => orden.indexOf(a.fuente) - orden.indexOf(b.fuente));
  const ganador = evidencias[0]!;
  const otros = evidencias.slice(1);

  // ¿Coinciden todas las fuentes (excepto hora, que es heurística)?
  const noHora = evidencias.filter(e => e.fuente !== 'hora de cierre');
  const todosCoinciden = noHora.length >= 2 && noHora.every(e => e.valor === ganador.valor);
  // Discrepancia: hay otro extractor (no-hora) con valor distinto al ganador.
  const discrepa = noHora.find(e => e.valor !== ganador.valor);
  // Solo hora detectó.
  const soloHora = evidencias.length === 1 && ganador.fuente === 'hora de cierre';

  let confianza: CampoDetectado<TurnoNombre>['confianza'] = 'media';
  let nota: string | null = null;

  if (todosCoinciden) {
    confianza = 'alta';
  } else if (discrepa) {
    confianza = 'media';
    nota = `Discrepancia: "${discrepa.fuente}" detectó "${discrepa.valor}". Se prioriza "${ganador.fuente}" → "${ganador.valor}".`;
  } else if (soloHora) {
    confianza = 'baja';
    nota = 'Turno deducido por hora de cierre (último recurso). Verificá manualmente.';
  } else if (noHora.length === 1) {
    confianza = 'media';
  }

  // Si hay hora y la hora discrepa con el ganador, también dejar nota.
  const hora = evidencias.find(e => e.fuente === 'hora de cierre');
  if (hora && hora.valor !== ganador.valor && !nota) {
    nota = `La hora de cierre sugiere "${hora.valor}" pero el campo dice "${ganador.valor}".`;
  }

  return {
    valor: ganador.valor,
    fuente: ganador.fuente,
    confianza,
    evidencias: [ganador, ...otros],
    nota,
  };
}
