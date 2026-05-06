// ────────────────────────────────────────────────────────────────────────────
// Parser Maxirest v3 — versión simple
//
// Reemplaza el parser v2 (4 capas, 11 archivos, 36 tests) que se rompía
// cada vez que aparecía un cierre con formato ligeramente distinto. La
// filosofía nueva: leer SOLO 3 cosas (fecha, turno, medios) y, si no
// se encuentran, fallar con mensaje claro. Cero validaciones cruzadas,
// cero confianza ponderada, cero múltiples estrategias.
//
// Implementación: 3 funciones puras, regex sobre el texto crudo. La
// tolerancia (acentos, capitalización, espacios variables, separadores
// de cualquier longitud) está en cada función, no en una capa común.
// ────────────────────────────────────────────────────────────────────────────

export type Turno = 'mediodia' | 'noche';

export interface MedioCobro {
  nombre: string;
  monto: number;
  cantidad: number;
}

export interface ParsedCierre {
  fecha: Date;
  turno: Turno;
  medios: MedioCobro[];
}

export interface ParseError {
  campo: 'fecha' | 'turno' | 'medios';
  mensaje: string;
}

export type ParseResult =
  | { ok: true; data: ParsedCierre }
  | { ok: false; errores: ParseError[] };

export const PARSER_VERSION = 'maxirest-v3-2026.05.06';

// ── Entrada principal ──────────────────────────────────────────────────────

export function parseCierre(texto: string): ParseResult {
  const errores: ParseError[] = [];

  const turno = extraerTurno(texto);
  if (!turno) errores.push({
    campo: 'turno',
    mensaje: 'No se encontró la línea "Turno: Mediodía" o "Turno: Noche".',
  });

  const fecha = extraerFecha(texto);
  if (!fecha) errores.push({
    campo: 'fecha',
    mensaje: 'No se encontró la fecha del cierre (ej: "Lunes 4 de Mayo de 2026").',
  });

  const medios = extraerMedios(texto);
  if (!medios || medios.length === 0) errores.push({
    campo: 'medios',
    mensaje: 'No se encontró la sección "VENTAS POR FORMA DE COBRO" o no tiene filas válidas.',
  });

  if (errores.length > 0) return { ok: false, errores };
  return { ok: true, data: { fecha: fecha!, turno: turno!, medios: medios! } };
}

// ── Extractores ────────────────────────────────────────────────────────────

function normalizar(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

export function extraerTurno(texto: string): Turno | null {
  // Primer match de "Turno: <palabra>" (case insensitive). El header
  // "Turno 2 (Noche)" / "[Noche]" NO matchea porque exige los dos puntos.
  const m = texto.match(/turno\s*:\s*([A-Za-záéíóúÁÉÍÓÚñÑ]+)/i);
  if (!m || !m[1]) return null;
  const v = normalizar(m[1]);
  if (v === 'noche') return 'noche';
  if (v === 'mediodia') return 'mediodia';
  return null;
}

const MESES_ES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

export function extraerFecha(texto: string): Date | null {
  // <D> de <Mes> de <YYYY>. El día de la semana puede o no aparecer
  // antes; no lo capturamos.
  const m = texto.match(/(\d{1,2})\s+de\s+([A-Za-záéíóúÁÉÍÓÚ]+)\s+de\s+(\d{4})/i);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const dia = parseInt(m[1], 10);
  const mes = MESES_ES[normalizar(m[2])];
  const anio = parseInt(m[3], 10);
  if (!mes || dia < 1 || dia > 31 || anio < 2000 || anio > 2100) return null;
  return new Date(anio, mes - 1, dia);
}

function parseMonto(s: string): number | null {
  // "1.234,56" → 1234.56  ·  "1234.56" → 1234.56  ·  "1234,56" → 1234.56
  if (!s) return null;
  let x = s;
  const lastComma = x.lastIndexOf(',');
  const lastDot = x.lastIndexOf('.');
  if (lastComma > lastDot) x = x.replace(/\./g, '').replace(',', '.');
  else if (lastComma >= 0 && lastDot < 0) x = x.replace(',', '.');
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

export function extraerMedios(texto: string): MedioCobro[] | null {
  // 1. Localizar "VENTAS POR FORMA DE COBRO" en el texto.
  const idx = texto.search(/VENTAS\s+POR\s+FORMA\s+DE\s+COBRO/i);
  if (idx === -1) return null;

  const lineas = texto.slice(idx).split('\n');

  // 2. Saltar hasta la línea header ("Forma de cobro ... Total ... Cant").
  let inicio = -1;
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i]!.trim();
    if (/forma\s+de\s+cobro/i.test(l) && /total/i.test(l) && /cant/i.test(l)) {
      inicio = i + 1;
      break;
    }
  }
  if (inicio === -1) return null;

  // 3. Leer filas hasta el corte de sección.
  const medios: MedioCobro[] = [];
  for (let i = inicio; i < lineas.length; i++) {
    const l = lineas[i]!.trim();
    if (!l) continue;
    if (/^[~=-]{3,}$/.test(l)) continue;           // separador decorativo
    if (/^TOTAL\b/i.test(l)) break;                // fin: línea TOTAL …
    if (/^RESUMEN\b/i.test(l)) break;              // fin: bloque RESUMEN

    // Tomar los 2 últimos tokens: cantidad (entero) + monto (numérico).
    // Lo previo es el nombre. Tolerante a espacios variables.
    const tokens = l.split(/\s+/);
    if (tokens.length < 3) continue;
    const cantStr = tokens[tokens.length - 1]!;
    const montoStr = tokens[tokens.length - 2]!;
    if (!/^\d+$/.test(cantStr)) continue;
    if (!/^[\d.,]+$/.test(montoStr)) continue;
    const cantidad = parseInt(cantStr, 10);
    const monto = parseMonto(montoStr);
    if (monto == null || monto <= 0 || cantidad <= 0) continue;
    const nombre = tokens.slice(0, -2).join(' ').trim();
    if (!nombre) continue;
    medios.push({ nombre, monto, cantidad });
  }

  return medios.length > 0 ? medios : null;
}
