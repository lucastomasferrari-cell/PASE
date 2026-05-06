// ────────────────────────────────────────────────────────────────────────────
// Extractor de VENTAS POR FORMA DE COBRO
//
// Lee la sección "ventas_por_cobro" línea por línea. Cada línea válida
// tiene: <nombre del medio> <monto> <cantidad>.
// Filtra subtotales (TARJETAS, OTROS, RESUMEN, TOTAL) y filas con cant=0.
// Devuelve la lista cruda — el mapeo a catálogo dinámico vive en el
// caller (la UI tiene acceso al hook useMediosCobro y al local activo).
// ────────────────────────────────────────────────────────────────────────────

import type { CampoDetectado, MedioVenta, TokenizedDoc } from '../types';
import { bloqueOTodo } from '../tokenizer';
import { parseMontoAR } from './totales';

const SUBTOTALES_IGNORAR = new Set([
  'TARJETAS', 'OTROS', 'RESUMEN', 'SUBTOTAL', 'FORMA DE COBRO',
  'TOTAL', 'TOTAL VENTAS', 'TOTAL EGRESOS', 'TOTAL INGRESOS',
]);

function esLineaTotal(upper: string): boolean {
  if (upper === 'TOTAL') return true;
  if (upper.startsWith('TOTAL ')) return true;
  return SUBTOTALES_IGNORAR.has(upper);
}

function esDecorador(linea: string): boolean {
  return /^[~=\-·•*_\s]+$/.test(linea);
}

interface Parsed {
  raw: string;
  monto: number;
  cantidad: number;
}

/**
 * Parsea una línea con el patrón <nombre> <monto> <cantidad>. Tolerante
 * a espacios múltiples, tabs y NBSP. Si la línea no encaja con el patrón,
 * devuelve null (la línea se ignora — no es un medio de cobro).
 */
function parseLineaMedio(linea: string): Parsed | null {
  const trimmed = linea.replace(/\r/g, '').trim();
  if (!trimmed) return null;
  if (esDecorador(trimmed)) return null;

  // Tokens separados por espacios (o NBSP). El último debe ser un entero
  // (cantidad). El penúltimo debe ser un número con dígitos+coma+punto
  // (monto). Lo previo es el nombre del medio.
  const toks = trimmed.split(/[\s ]+/);
  if (toks.length < 3) return null;
  const cantStr = toks[toks.length - 1]!;
  const montoStr = toks[toks.length - 2]!;
  if (!/^\d+$/.test(cantStr)) return null;
  if (!/^[\d.,]+$/.test(montoStr)) return null;
  const cant = parseInt(cantStr, 10);
  const monto = parseMontoAR(montoStr);
  if (monto == null || cant <= 0 || monto <= 0) return null;
  const nombre = toks.slice(0, -2).join(' ').trim();
  if (!nombre) return null;
  return { raw: nombre, monto, cantidad: cant };
}

export function extractMedios(t: TokenizedDoc): CampoDetectado<MedioVenta[]> {
  const bloque = bloqueOTodo(t, 'ventas_por_cobro');
  // Si solo encontramos el documento entero (no había anchor), buscamos
  // a partir de la primera línea con "VENTAS POR FORMA DE COBRO" o similar.
  let texto = bloque;
  const idxFallback = texto.search(/VENTAS\s+POR\s+FORMA\s+DE\s+(?:COBRO|PAGO)|RESUMEN\s+DE\s+VENTAS/i);
  if (idxFallback > -1) texto = texto.slice(idxFallback);

  const lineas = texto.split('\n');
  const medios: MedioVenta[] = [];
  let enBloque = true;
  let bloqueIniciado = false;
  for (const linea of lineas) {
    const trimmed = linea.replace(/\r/g, '').trim();
    if (!trimmed) continue;
    const upper = trimmed.toUpperCase();
    // Saltar el header del bloque (la línea con la frase anchor).
    if (!bloqueIniciado && /VENTAS\s+POR\s+FORMA|RESUMEN\s+DE\s+VENTAS/i.test(trimmed)) {
      bloqueIniciado = true;
      continue;
    }
    bloqueIniciado = true;
    if (esLineaTotal(upper)) { enBloque = false; continue; }
    if (!enBloque) continue;
    if (esDecorador(trimmed)) continue;
    const p = parseLineaMedio(trimmed);
    if (!p) continue;
    if (SUBTOTALES_IGNORAR.has(p.raw.toUpperCase())) continue;
    medios.push(p);
  }

  if (medios.length === 0) {
    return {
      valor: null, fuente: null, confianza: 'ausente',
      evidencias: [], nota: 'No se detectaron medios de cobro.',
    };
  }

  return {
    valor: medios, fuente: 'sección "ventas por forma de cobro"',
    confianza: 'alta',
    evidencias: medios.map(m => ({
      fuente: 'sección "ventas por forma de cobro"',
      valor: [m] as MedioVenta[],
      raw: `${m.raw} ${m.monto} ${m.cantidad}`,
    })),
    nota: null,
  };
}
