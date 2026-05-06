// ────────────────────────────────────────────────────────────────────────────
// Capa 1 — Tokenización semántica
//
// Toma el texto crudo del cierre y lo divide en bloques lógicos
// (header, ventas_por_cobro, totales, movimientos, resumen).
//
// Estrategia: buscar "anchors" — palabras clave fijas en cualquier
// capitalización/acento que marcan inicio de sección. Entre dos anchors
// hay una sección. Antes del primer anchor, header. Después del último,
// resumen.
//
// Tolerancias:
// - Mayúsculas / minúsculas / acentos.
// - Espaciado: NBSP ( ), tabs, múltiples espacios.
// - Separadores decorativos (~, =, -, ·) que rodean los anchors.
// - Líneas vacías intermedias.
// ────────────────────────────────────────────────────────────────────────────

import type { TokenizedDoc } from './types';

/** Saca acentos + lowercase + collapse NBSP/tabs a espacio simple. */
export function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Anchor {
  tipo: 'ventas_por_cobro' | 'totales' | 'movimientos' | 'resumen';
  /** Patrones normalizados que disparan el anchor. */
  patrones: string[];
}

const ANCHORS: Anchor[] = [
  // El de ventas va primero porque algunos cierres tienen "resumen ventas"
  // que NO es nuestro anchor "resumen" sino el inicio del bloque de cobros.
  { tipo: 'ventas_por_cobro', patrones: [
    'ventas por forma de cobro',
    'ventas por forma de pago',
    'resumen de ventas',
    'totales por forma de cobro',
    'totales por forma de pago',
  ] },
  { tipo: 'totales', patrones: [
    'totales del cierre',
    'totales de caja',
    'total caja',
    'subtotal ingresos',
    'subtotal egresos',
    'saldo de caja',
    'totales generales',
  ] },
  { tipo: 'movimientos', patrones: [
    'movimientos de caja',
    'detalle de movimientos',
    'movimientos del turno',
    'movimientos',
  ] },
  { tipo: 'resumen', patrones: [
    'observaciones',
    'firma del cajero',
    'firma del responsable',
    'cierre realizado por',
  ] },
];

interface MarcadorEncontrado {
  tipo: Anchor['tipo'];
  offset: number;
  linea: string;
  patron: string;
}

/** Busca todas las apariciones de los anchors en el texto, ordenadas por offset. */
function localizarAnchors(texto: string): MarcadorEncontrado[] {
  const lineas = texto.split('\n');
  const marcadores: MarcadorEncontrado[] = [];
  let offset = 0;
  for (const linea of lineas) {
    const norm = normalizar(linea);
    for (const a of ANCHORS) {
      // Aceptar patrón aunque la línea tenga decoradores (~, =, -, ·) alrededor.
      // Sustraemos esos chars antes de comparar.
      const limpio = norm.replace(/[=~\-·•*_]+/g, ' ').replace(/\s+/g, ' ').trim();
      for (const p of a.patrones) {
        if (limpio === p || limpio.startsWith(p + ' ') || limpio.startsWith(p + ':')) {
          marcadores.push({ tipo: a.tipo, offset, linea, patron: p });
          break;
        }
      }
    }
    offset += linea.length + 1; // +1 por el \n
  }
  return marcadores.sort((a, b) => a.offset - b.offset);
}

/** Extrae el texto entre dos offsets (excluye marcador final). */
function rango(texto: string, desde: number, hasta: number): string {
  return texto.slice(desde, hasta);
}

/**
 * Tokeniza el texto en bloques. Si un anchor no aparece, su sección queda
 * vacía. El header siempre es el bloque inicial (puede coincidir con
 * `raw` si no se detectó ningún anchor).
 */
export function tokenize(texto: string): TokenizedDoc {
  const marcadores = localizarAnchors(texto);
  const out: TokenizedDoc = {
    raw: texto,
    header: '',
    ventas_por_cobro: '',
    totales: '',
    movimientos: '',
    resumen: '',
    marcadores: marcadores.map(m => ({ tipo: m.tipo, offset: m.offset, linea: m.linea })),
  };

  if (marcadores.length === 0) {
    // Sin anchors: todo es header. Los extractores trabajan sobre `raw`
    // como fallback en este caso.
    out.header = texto;
    return out;
  }

  // Header = desde 0 hasta el primer anchor.
  out.header = rango(texto, 0, marcadores[0]!.offset);

  // Recorrer marcadores en orden, asignar el rango hasta el siguiente
  // marcador de OTRO tipo. Si hay dos del mismo tipo seguidos (raro),
  // se concatenan.
  for (let i = 0; i < marcadores.length; i++) {
    const m = marcadores[i]!;
    const fin = i + 1 < marcadores.length ? marcadores[i + 1]!.offset : texto.length;
    const bloque = rango(texto, m.offset, fin);
    if (out[m.tipo]) out[m.tipo] += '\n' + bloque;
    else out[m.tipo] = bloque;
  }

  return out;
}

/**
 * Helper: devuelve el bloque relevante para un campo. Si la sección
 * pedida está vacía, devuelve `raw` (el extractor usa el documento
 * completo como fallback).
 */
export function bloqueOTodo(t: TokenizedDoc, seccion: keyof TokenizedDoc): string {
  const v = t[seccion];
  if (typeof v !== 'string') return t.raw;
  return v.trim().length > 0 ? v : t.raw;
}
