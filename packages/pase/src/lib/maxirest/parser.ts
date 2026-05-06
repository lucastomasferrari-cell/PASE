// ────────────────────────────────────────────────────────────────────────────
// Orquestador del parser Maxirest v2
//
// Recibe el texto crudo del cierre y devuelve un CierreMaxirest con todos
// los campos detectados, evidencias, confianzas y warnings cruzados.
//
// La UI lo consume así:
//   const cierre = parseCierreMaxirest(texto);
//   if (cierre.warnings.some(w => w.severidad === 'critical')) … bloquear …
//   render(cierre)  // cada campo es editable, ver capa 4.
//
// El parser NO toca DB. La UI valida `localNombre` contra la tabla
// `locales` después de recibir el resultado (con `useLocales` o equivalente).
// ────────────────────────────────────────────────────────────────────────────

import { tokenize } from './tokenizer';
import {
  extractTurno, extractFecha, extractLocalNombre, extractCuit,
  extractHoraApertura, extractHoraCierre, extractCierreNumero, extractCubiertos,
  extractTotalIngresos, extractTotalEgresos, extractSaldoCaja, extractMedios,
} from './extractors';
import { validarCierre } from './validators';
import { PARSER_VERSION, type CierreMaxirest } from './types';

export function parseCierreMaxirest(texto: string): CierreMaxirest {
  const tokens = tokenize(texto);
  const cierre: CierreMaxirest = {
    fecha:           extractFecha(tokens),
    turno:           extractTurno(tokens),
    localNombre:     extractLocalNombre(tokens),
    cuit:            extractCuit(tokens),
    cierreNumero:    extractCierreNumero(tokens),
    horaApertura:    extractHoraApertura(tokens),
    horaCierre:      extractHoraCierre(tokens),
    cubiertos:       extractCubiertos(tokens),
    totalIngresos:   extractTotalIngresos(tokens),
    totalEgresos:    extractTotalEgresos(tokens),
    saldoCaja:       extractSaldoCaja(tokens),
    ventasPorMedio:  extractMedios(tokens),
    warnings:        [],
    parserVersion:   PARSER_VERSION,
    tokens,
  };
  cierre.warnings = validarCierre(cierre);
  return cierre;
}
