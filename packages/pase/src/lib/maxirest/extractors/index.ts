// Barrel — re-export limpio para los callers.
export { extractTurno } from './turno';
export { extractFecha } from './fecha';
export { extractLocalNombre, extractCuit } from './local';
export {
  extractHoraApertura, extractHoraCierre, extractCierreNumero, extractCubiertos,
} from './horas';
export { extractTotalIngresos, extractTotalEgresos, extractSaldoCaja, parseMontoAR } from './totales';
export { extractMedios } from './medios';
