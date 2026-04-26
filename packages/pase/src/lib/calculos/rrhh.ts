// ─── RRHH: Funciones puras de cálculo ────────────────────────────────────────
// Todas las funciones son entrada → salida, sin side effects ni dependencia
// de fecha actual (se recibe como parámetro cuando es necesario).

// ─── TIPOS ───────────────────────────────────────────────────────────────────

export interface LiquidacionParams {
  sueldo_mensual: number;
  modo_pago: "MENSUAL" | "QUINCENAL" | "SEMANAL";
  inasistencias: number;
  horas_extras: number;
  dobles: number;
  valor_doble: number;
  feriados: number;
  vacaciones_dias: number;
  presentismo_mantiene: boolean;
  adelantos: number;
  pagos_dobles_realizados: number;
}

export interface LiquidacionResult {
  sueldo_base: number;
  descuento_ausencias: number;
  total_horas_extras: number;
  total_dobles: number;
  total_feriados: number;
  total_vacaciones: number;
  subtotal1: number;
  monto_presentismo: number;
  subtotal2: number;
  adelantos: number;
  pagos_realizados: number;
  total_a_pagar: number;
}

export interface LiquidacionFinalParams {
  sueldo_mensual: number;
  fecha_inicio: string;
  fecha_egreso: string;
  vacaciones_acumuladas: number; // días disponibles (ya neto de tomadas)
  motivo: "Renuncia" | "Despido sin causa" | "Despido con causa" | "Acuerdo mutuo";
}

export interface LiquidacionFinalResult {
  proporcional_mes: number;
  vacaciones_dinero: number;
  sac_proporcional: number;
  indemnizacion: number;
  preaviso: number;
  integracion_mes: number;
  total: number;
}

// ─── VACACIONES ──────────────────────────────────────────────────────────────

/** Días de vacaciones por año según antigüedad (ley argentina) */
export function diasVacacionesPorAnio(antiguedadAnios: number): number {
  if (antiguedadAnios < 5) return 14;
  if (antiguedadAnios < 10) return 21;
  if (antiguedadAnios < 20) return 28;
  return 35;
}

/**
 * Calcula días de vacaciones acumuladas disponibles.
 * @param fechaInicio - fecha de ingreso del empleado (YYYY-MM-DD)
 * @param diasTomados - días de vacaciones ya usados (de novedades confirmadas)
 * @param ahora - fecha de referencia (default: hoy) — inyectable para tests
 */
export function calcularVacaciones(
  fechaInicio: string | null | undefined,
  diasTomados: number = 0,
  ahora: Date = new Date(),
): number {
  if (!fechaInicio) return 0;
  const inicio = new Date(fechaInicio + "T12:00:00");
  if (isNaN(inicio.getTime())) return 0;
  const mesesTrabajados =
    (ahora.getFullYear() - inicio.getFullYear()) * 12 +
    (ahora.getMonth() - inicio.getMonth());
  if (mesesTrabajados <= 0) return 0;
  const anios = mesesTrabajados / 12;
  const diasPorAnio = diasVacacionesPorAnio(anios);
  const acumulados = (diasPorAnio / 12) * mesesTrabajados;
  return Math.max(0, acumulados - diasTomados);
}

// ─── SAC / AGUINALDO ─────────────────────────────────────────────────────────

/** SAC teórico del semestre completo = sueldo / 2 */
export function calcularSACTeorico(sueldo: number): number {
  if (sueldo <= 0) return 0;
  return sueldo / 2;
}

/**
 * SAC acumulado proporcional al mes actual dentro del semestre.
 * @param sueldo - sueldo mensual
 * @param mesActual - mes 1-12 (enero=1, diciembre=12)
 */
export function calcularSACProporcional(sueldo: number, mesActual: number): number {
  if (sueldo <= 0 || mesActual < 1 || mesActual > 12) return 0;
  const mesesEnSemestre = mesActual <= 6 ? mesActual : mesActual - 6;
  return (sueldo / 12) * mesesEnSemestre;
}

/**
 * Meses trabajados dentro del semestre actual, considerando fecha_inicio.
 * Semestre 1: enero-junio. Semestre 2: julio-diciembre.
 * Si el empleado ingresó antes del semestre → cuenta mesActual meses.
 * Si ingresó dentro del semestre → cuenta desde su mes de ingreso.
 * Si ingresó después del mes actual → 0.
 */
export function mesesTrabajadosEnSemestre(
  fechaInicio: string | null | undefined,
  mesActual: number,
  anioActual: number,
): number {
  if (mesActual < 1 || mesActual > 12) return 0;
  const inicioSemestreMes = mesActual <= 6 ? 1 : 7;
  if (!fechaInicio) return mesActual - inicioSemestreMes + 1;
  const inicio = new Date(fechaInicio + "T12:00:00");
  if (isNaN(inicio.getTime())) return mesActual - inicioSemestreMes + 1;
  const inicioAnio = inicio.getFullYear();
  const inicioMes = inicio.getMonth() + 1;
  // Ingreso en año posterior o mes posterior al actual → no trabajó en este semestre
  if (inicioAnio > anioActual) return 0;
  if (inicioAnio === anioActual && inicioMes > mesActual) return 0;
  // Ingresó antes del inicio del semestre → cuenta el semestre completo hasta mesActual
  const ingresoAntesDelSemestre =
    inicioAnio < anioActual || inicioMes < inicioSemestreMes;
  const mesArranque = ingresoAntesDelSemestre ? inicioSemestreMes : inicioMes;
  return Math.max(0, mesActual - mesArranque + 1);
}

/**
 * Mayor sueldo devengado dentro del semestre actual.
 * Considera el sueldo actual y los cambios registrados en rrhh_historial_sueldos
 * dentro del semestre. El "mejor sueldo" es el máximo (Art 122 LCT).
 */
export function calcularMejorSueldoSemestre(
  sueldoActual: number,
  historialSueldos: Array<{ sueldo_anterior?: number; sueldo_nuevo?: number; fecha_cambio?: string }> | null | undefined,
  mesActual: number,
  anioActual: number,
): number {
  if (sueldoActual <= 0 && (!historialSueldos || historialSueldos.length === 0)) return 0;
  const inicioSemestreMes = mesActual <= 6 ? 1 : 7;
  const inicioSem = new Date(anioActual, inicioSemestreMes - 1, 1).getTime();
  let mejor = Math.max(0, sueldoActual);
  for (const h of historialSueldos || []) {
    if (!h.fecha_cambio) continue;
    const t = new Date(h.fecha_cambio).getTime();
    if (isNaN(t)) continue;
    // Cambios aplicados dentro del semestre aportan el sueldo_nuevo.
    if (t >= inicioSem) {
      if (h.sueldo_nuevo && h.sueldo_nuevo > mejor) mejor = h.sueldo_nuevo;
      if (h.sueldo_anterior && h.sueldo_anterior > mejor) mejor = h.sueldo_anterior;
    } else {
      // Cambio previo al semestre: el sueldo_nuevo es el vigente al inicio del semestre.
      if (h.sueldo_nuevo && h.sueldo_nuevo > mejor) mejor = h.sueldo_nuevo;
    }
  }
  return mejor;
}

/**
 * SAC acumulado usando el mejor sueldo del semestre, prorrateado por tiempo
 * efectivamente trabajado (Art 122 LCT). Reemplaza calcularSACProporcional
 * cuando se dispone del historial de sueldos y la fecha de ingreso.
 */
export function calcularSACMejorSueldo(params: {
  sueldoActual: number;
  historialSueldos?: Array<{ sueldo_anterior?: number; sueldo_nuevo?: number; fecha_cambio?: string }> | null;
  fechaInicio?: string | null;
  mesActual: number;
  anioActual: number;
}): number {
  const { sueldoActual, historialSueldos, fechaInicio, mesActual, anioActual } = params;
  const mejor = calcularMejorSueldoSemestre(sueldoActual, historialSueldos || null, mesActual, anioActual);
  if (mejor <= 0) return 0;
  const meses = mesesTrabajadosEnSemestre(fechaInicio, mesActual, anioActual);
  if (meses <= 0) return 0;
  return (mejor / 12) * meses;
}

// ─── LIQUIDACIÓN MENSUAL — COMPONENTES ───────────────────────────────────────

/** Sueldo base según modo de pago */
export function calcularSueldoBase(
  sueldo_mensual: number,
  modo_pago: "MENSUAL" | "QUINCENAL" | "SEMANAL",
): number {
  if (modo_pago === "QUINCENAL") return sueldo_mensual / 2;
  if (modo_pago === "SEMANAL") return sueldo_mensual / 4;
  return sueldo_mensual;
}

/** Descuento por inasistencias = inasistencias × valor_dia */
export function calcularDescuentoAusencias(inasistencias: number, sueldo: number): number {
  if (inasistencias <= 0 || sueldo <= 0) return 0;
  const valorDia = sueldo / 30;
  return inasistencias * valorDia;
}

/** Total horas extras = horas × valor_hora (valor_hora = sueldo/30/8) */
export function calcularHorasExtras(horas: number, sueldo: number): number {
  if (horas <= 0 || sueldo <= 0) return 0;
  const valorHora = sueldo / 30 / 8;
  return horas * valorHora;
}

/** Presentismo = 5% del sueldo mensual si mantiene, 0 si no */
export function calcularPresentismo(sueldo: number, mantiene: boolean): number {
  if (!mantiene || sueldo <= 0) return 0;
  return sueldo * 0.05;
}

// ─── LIQUIDACIÓN MENSUAL — TOTAL ─────────────────────────────────────────────

/** Calcula la liquidación mensual completa */
export function calcularTotalLiquidacion(params: LiquidacionParams): LiquidacionResult {
  const {
    sueldo_mensual, modo_pago, inasistencias, horas_extras,
    dobles, valor_doble, feriados, vacaciones_dias,
    presentismo_mantiene, adelantos, pagos_dobles_realizados,
  } = params;

  const sueldo_base = calcularSueldoBase(sueldo_mensual, modo_pago);
  const valor_dia = sueldo_mensual / 30;
  const valor_dia_vacacional = sueldo_mensual / 25; // LCT Art 155: vacaciones se calculan sobre días hábiles
  const descuento_ausencias = calcularDescuentoAusencias(inasistencias, sueldo_mensual);
  const total_horas_extras = calcularHorasExtras(horas_extras, sueldo_mensual);
  const total_dobles = Math.max(0, dobles) * Math.max(0, valor_doble);
  const total_feriados = Math.max(0, feriados) * valor_dia;
  const total_vacaciones = Math.max(0, vacaciones_dias) * valor_dia_vacacional;
  const subtotal1 =
    sueldo_base - descuento_ausencias + total_horas_extras +
    total_dobles + total_feriados + total_vacaciones;
  const monto_presentismo = calcularPresentismo(sueldo_mensual, presentismo_mantiene);
  const subtotal2 = subtotal1 + monto_presentismo;
  const total_a_pagar = Math.round(subtotal2 - Math.max(0, adelantos) - Math.max(0, pagos_dobles_realizados));

  return {
    sueldo_base,
    descuento_ausencias,
    total_horas_extras,
    total_dobles,
    total_feriados,
    total_vacaciones,
    subtotal1,
    monto_presentismo,
    subtotal2,
    adelantos: Math.max(0, adelantos),
    pagos_realizados: Math.max(0, pagos_dobles_realizados),
    total_a_pagar,
  };
}

// ─── LIQUIDACIÓN FINAL ───────────────────────────────────────────────────────

/** Calcula liquidación final al egreso del empleado */
export function calcularLiquidacionFinal(params: LiquidacionFinalParams): LiquidacionFinalResult {
  const { sueldo_mensual, fecha_inicio, fecha_egreso, vacaciones_acumuladas, motivo } = params;

  const valorDia = sueldo_mensual / 30;
  const fechaEg = new Date(fecha_egreso + "T12:00:00");
  const diaDelMes = fechaEg.getDate();

  // Proporcional del mes trabajado
  const proporcional_mes = valorDia * diaDelMes;

  // Vacaciones no tomadas en dinero (LCT Art 155: sueldo/25)
  const valor_dia_vacacional = sueldo_mensual / 25;
  const vacaciones_dinero = Math.max(0, vacaciones_acumuladas) * valor_dia_vacacional;

  // SAC proporcional del semestre
  const inicioSem = fechaEg.getMonth() < 6
    ? new Date(fechaEg.getFullYear(), 0, 1)
    : new Date(fechaEg.getFullYear(), 6, 1);
  const diasEnSem = Math.max(0, Math.ceil((fechaEg.getTime() - inicioSem.getTime()) / 86400000));
  const sac_proporcional = (sueldo_mensual / 2) * (diasEnSem / 180);

  // Indemnización y preaviso solo para despido sin causa
  const esDespido = motivo === "Despido sin causa";

  const fi = new Date(fecha_inicio + "T12:00:00");
  const antiguedadMs = fechaEg.getTime() - fi.getTime();
  const antiguedadAnios = Math.max(1, Math.floor(antiguedadMs / (365.25 * 24 * 60 * 60 * 1000)));

  const indemnizacion = esDespido ? sueldo_mensual * antiguedadAnios : 0;
  const preaviso = esDespido ? (antiguedadAnios < 5 ? valorDia * 15 : sueldo_mensual) : 0;

  // Integración mes de despido
  const diasRestantesMes = new Date(fechaEg.getFullYear(), fechaEg.getMonth() + 1, 0).getDate() - diaDelMes;
  const integracion_mes = esDespido ? valorDia * diasRestantesMes : 0;

  const total = Math.max(0,
    proporcional_mes + vacaciones_dinero + sac_proporcional +
    indemnizacion + preaviso + integracion_mes,
  );

  return {
    proporcional_mes,
    vacaciones_dinero,
    sac_proporcional,
    indemnizacion,
    preaviso,
    integracion_mes,
    total,
  };
}
