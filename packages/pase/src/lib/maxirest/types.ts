// ────────────────────────────────────────────────────────────────────────────
// Maxirest parser — tipos compartidos
//
// Filosofía del módulo (refactor 2026-05-08):
//
// - Cada campo se detecta con MÚLTIPLES estrategias, cada una devuelve
//   un valor + una fuente (texto del marcador). Un orquestador combina
//   las estrategias y resuelve discrepancias.
// - Los extractores son funciones puras: reciben texto + tokens + opciones,
//   devuelven CampoDetectado<T>. Sin side effects, sin acceso a DB.
// - Los validators corren AL FINAL, sobre el resultado parcial. Devuelven
//   warnings con severidad. La UI decide si bloquea importar.
// - El usuario puede SOBRE-ESCRIBIR cualquier campo en el preview. Un
//   campo editado pasa a confianza='editado' y queda registrado en el
//   audit log al confirmar.
// ────────────────────────────────────────────────────────────────────────────

export type TurnoNombre = 'Mediodía' | 'Noche';

export type Confianza = 'alta' | 'media' | 'baja' | 'editado' | 'ausente';

/** Resultado de extraer un campo del cierre. */
export interface CampoDetectado<T> {
  /** Valor final (puede ser null si nada matcheó). */
  valor: T | null;
  /** Etiqueta de la fuente que ganó (ej: 'campo Turno:', 'header'). */
  fuente: string | null;
  /** Confianza global del campo. */
  confianza: Confianza;
  /** Todas las fuentes que produjeron un valor (para debug). */
  evidencias: Array<{ fuente: string; valor: T; raw: string }>;
  /** Mensaje opcional para mostrar en la UI debajo del campo. */
  nota: string | null;
}

export type Severidad = 'info' | 'warning' | 'critical';

export interface Warning {
  campo: string;
  severidad: Severidad;
  mensaje: string;
  detalle?: string;
}

export interface MedioVenta {
  /** Texto crudo como apareció en el archivo. */
  raw: string;
  monto: number;
  cantidad: number;
}

/** Documento tokenizado en secciones por marcadores semánticos. */
export interface TokenizedDoc {
  /** Texto original (no normalizado). */
  raw: string;
  /** Encabezado del cierre (antes del primer anchor de sección). */
  header: string;
  /** Bloque "ventas por forma de cobro" / "resumen de ventas". */
  ventas_por_cobro: string;
  /** Bloque de totales (subtotal ingresos / egresos / saldo). */
  totales: string;
  /** Movimientos individuales (líneas de detalle). */
  movimientos: string;
  /** Bloque final (firmas, observaciones). */
  resumen: string;
  /** Marcadores detectados para debug. */
  marcadores: Array<{ tipo: string; offset: number; linea: string }>;
}

/** Resultado completo del parser, listo para alimentar el preview editable. */
export interface CierreMaxirest {
  fecha:           CampoDetectado<string>;        // 'YYYY-MM-DD'
  turno:           CampoDetectado<TurnoNombre>;
  localNombre:     CampoDetectado<string>;        // texto detectado, no validado contra DB
  cuit:            CampoDetectado<string>;        // 11 dígitos (sin guiones)
  cierreNumero:    CampoDetectado<number>;
  horaApertura:    CampoDetectado<string>;        // 'HH:MM'
  horaCierre:      CampoDetectado<string>;        // 'HH:MM'
  cubiertos:       CampoDetectado<number>;
  totalIngresos:   CampoDetectado<number>;
  totalEgresos:    CampoDetectado<number>;
  saldoCaja:       CampoDetectado<number>;
  ventasPorMedio:  CampoDetectado<MedioVenta[]>;
  /** Warnings cruzados (turno+hora, fecha futura, totales no suman, etc.). */
  warnings:        Warning[];
  /** Versión del parser que produjo este resultado. Útil para auditoría. */
  parserVersion:   string;
  /** Tokens internos (para debug y para que la UI pueda mostrar bloques). */
  tokens:          TokenizedDoc;
}

export const PARSER_VERSION = 'maxirest-v2-2026.05.08';
