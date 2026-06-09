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
  /** Descuentos manuales arbitrarios (préstamos, daños, faltantes). */
  otros_descuentos?: number;
  /** Bonos / premios manuales que SUMAN al sueldo (productividad, etc.). */
  bono?: number;
  /** Número de cuota cuando es quincenal (1 o 2). Solo se usa para presentismo
   *  — en Q1 quincenal NO se paga (se difiere a Q2 cuando ya se sabe si lo
   *  perdió o no). Pedido Lucas 31-may. */
  cuota_num?: number;
  /** Total de cuotas del período (1 mensual / 2 quincenal). */
  cuotas_total?: number;
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
  otros_descuentos: number;
  bono: number;
  pagos_realizados: number;
  total_a_pagar: number;
}

// Taxonomía pedida por Lucas (08-jun). Reemplaza el viejo "Despido sin/con
// causa": ahora la distinción operativa es si HUBO o NO preaviso, que es lo
// que cambia los conceptos a pagar.
export type MotivoEgreso =
  | "Despido sin preaviso"
  | "Despido con preaviso"
  | "Renuncia"
  | "Acuerdo mutuo";

export interface LiquidacionFinalParams {
  sueldo_mensual: number;          // base indemnizatoria (mejor rem. normal y habitual)
  fecha_inicio: string;
  fecha_egreso: string;
  vacaciones_acumuladas: number;   // días disponibles (ya neto de tomadas)
  motivo: MotivoEgreso;
  /** Doble indemnización (decreto de emergencia). Default 1. Aplica a las
   *  indemnizaciones del despido (antigüedad, preaviso, integración). */
  indemnizacion_mult?: 1 | 2;
  /** Gratificación / extra manual ($). Default 0. Caso típico: acuerdo mutuo. */
  gratificacion?: number;
}

export interface LiquidacionFinalResult {
  proporcional_mes: number;   // días trabajados del mes
  sac_proporcional: number;   // SAC del semestre en curso
  vacaciones_dinero: number;  // vacaciones no gozadas (Art 155)
  sac_vacaciones: number;     // SAC sobre vacaciones no gozadas
  indemnizacion: number;      // antigüedad (Art 245)
  preaviso: number;           // sustitutiva de preaviso (Art 232)
  sac_preaviso: number;       // SAC sobre preaviso
  integracion_mes: number;    // integración mes de despido (Art 233)
  sac_integracion: number;    // SAC sobre integración
  gratificacion: number;      // extra manual (acuerdo, etc.)
  total: number;
  antiguedad_anios: number;   // años computados para Art 245 (con fracción > 3m)
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

/**
 * ¿El empleado está en período de prueba? LCT Art 92 bis: los primeros 6 meses
 * desde la fecha de ingreso. Devuelve false si no hay fecha, si la fecha es
 * inválida, si el ingreso es futuro, o si ya pasaron los 6 meses.
 * @param ahora - fecha de referencia (default hoy) — inyectable para tests.
 */
export function enPeriodoPrueba(
  fechaInicio: string | null | undefined,
  ahora: Date = new Date(),
): boolean {
  if (!fechaInicio) return false;
  const inicio = new Date(fechaInicio + "T12:00:00");
  if (isNaN(inicio.getTime())) return false;
  if (inicio.getTime() > ahora.getTime()) return false; // ingreso futuro
  const finPrueba = new Date(inicio);
  finPrueba.setMonth(finPrueba.getMonth() + 6);
  return ahora.getTime() < finPrueba.getTime();
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

/**
 * Total horas extras = horas × valor_hora (valor_hora = sueldo/30/8).
 * Acepta horas NEGATIVAS para descontar horas no trabajadas (pedido Anto
 * 2026-05-19). Ej: -2 horas con sueldo 720000 → -6000.
 */
export function calcularHorasExtras(horas: number, sueldo: number): number {
  if (horas === 0 || sueldo <= 0) return 0;
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
    otros_descuentos = 0,
    bono = 0,
    cuota_num, cuotas_total,
  } = params;

  const sueldo_base = calcularSueldoBase(sueldo_mensual, modo_pago);
  const valor_dia = sueldo_mensual / 30;
  // LCT Art 155: día de vacaciones se paga sobre días hábiles (sueldo/25).
  // PERO el sueldo_base mensual ya cubre los días que el empleado estuvo de
  // vacaciones (no se le descuenta por no asistir). Lo único que falta sumar
  // es el PLUS vacacional: diferencia entre el valor vacacional (sueldo/25)
  // y el valor del día normal (sueldo/30). Pedido Lucas 2026-05-19 — antes
  // sumaba el día completo y quedaba doblemente pago.
  const valor_dia_vacacional = sueldo_mensual / 25;
  const plus_vacacional_por_dia = valor_dia_vacacional - valor_dia;
  const descuento_ausencias = calcularDescuentoAusencias(inasistencias, sueldo_mensual);
  const total_horas_extras = calcularHorasExtras(horas_extras, sueldo_mensual);
  const total_dobles = Math.max(0, dobles) * Math.max(0, valor_doble);
  const total_feriados = Math.max(0, feriados) * valor_dia;
  const total_vacaciones = Math.max(0, vacaciones_dias) * plus_vacacional_por_dia;
  const subtotal1 =
    sueldo_base - descuento_ausencias + total_horas_extras +
    total_dobles + total_feriados + total_vacaciones;
  // Presentismo: si es Q1 quincenal NO se paga — se difiere a Q2 cuando ya
  // se sabe si lo perdió o no. En mensual o Q2 quincenal se paga el 5% del
  // sueldo MENSUAL completo. Pedido Lucas 31-may.
  const presentismo_aplica = !(cuotas_total === 2 && cuota_num === 1);
  const monto_presentismo = presentismo_aplica
    ? calcularPresentismo(sueldo_mensual, presentismo_mantiene)
    : 0;
  const subtotal2 = subtotal1 + monto_presentismo;
  const descuentos_extra = Math.max(0, otros_descuentos);
  const bono_extra = Math.max(0, bono);
  const total_a_pagar = Math.round(
    subtotal2 + bono_extra - Math.max(0, adelantos) - Math.max(0, pagos_dobles_realizados) - descuentos_extra,
  );

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
    otros_descuentos: descuentos_extra,
    bono: bono_extra,
    pagos_realizados: Math.max(0, pagos_dobles_realizados),
    total_a_pagar,
  };
}

// ─── AUMENTOS DE SUELDO ──────────────────────────────────────────────────────

export type TipoAumento = "pct" | "fijo";
export interface OpcionesAumento {
  tipo: TipoAumento;
  /** Para 'pct': porcentaje (30 = +30%). Para 'fijo': monto a sumar ($). */
  valor: number;
  /** Múltiplo al que redondear el resultado (100 = a $100). null/0 = sin redondeo. */
  redondeo?: number | null;
}

/**
 * Aplica un aumento a un sueldo base. Pedido Lucas 04-jun (planilla de sueldos
 * + aumentos masivos). Devuelve el sueldo nuevo, opcionalmente redondeado.
 *
 * - 'pct': nuevo = actual * (1 + valor/100)
 * - 'fijo': nuevo = actual + valor
 *
 * El redondeo es al múltiplo más cercano (Math.round). Nunca devuelve negativo
 * (clamp a 0 — la RPC igual rechaza <= 0, esto es para el preview).
 */
export function aplicarAumento(actual: number, opts: OpcionesAumento): number {
  const base = Number.isFinite(actual) ? actual : 0;
  const v = Number.isFinite(opts.valor) ? opts.valor : 0;
  let nuevo = opts.tipo === "pct" ? base * (1 + v / 100) : base + v;
  if (nuevo < 0) nuevo = 0;
  const r = opts.redondeo ?? null;
  if (r && r > 0) nuevo = Math.round(nuevo / r) * r;
  else nuevo = Math.round(nuevo); // sin múltiplo: a entero (los sueldos no llevan centavos)
  return nuevo;
}

// ─── LIQUIDACIÓN FINAL ───────────────────────────────────────────────────────

/** Meses completos de antigüedad entre ingreso y egreso. */
export function mesesAntiguedadCompletos(fechaInicio: string, fechaEgreso: string): number {
  const fi = new Date(fechaInicio + "T12:00:00");
  const fe = new Date(fechaEgreso + "T12:00:00");
  if (isNaN(fi.getTime()) || isNaN(fe.getTime())) return 0;
  let m = (fe.getFullYear() - fi.getFullYear()) * 12 + (fe.getMonth() - fi.getMonth());
  if (fe.getDate() < fi.getDate()) m -= 1; // mes incompleto no cuenta
  return Math.max(0, m);
}

/**
 * Años computables para indemnización por antigüedad (LCT Art 245): cada año
 * de servicio O FRACCIÓN MAYOR A 3 MESES se computa como año entero. Mínimo 1.
 */
export function aniosIndemnizatorios(fechaInicio: string, fechaEgreso: string): number {
  const meses = mesesAntiguedadCompletos(fechaInicio, fechaEgreso);
  const aniosCompletos = Math.floor(meses / 12);
  const mesesResto = meses % 12;
  return Math.max(1, aniosCompletos + (mesesResto > 3 ? 1 : 0));
}

/**
 * Preaviso sustitutivo (LCT Art 232), en pesos:
 *   - antigüedad < 3 meses (período de prueba) → 15 días (sueldo/30 × 15)
 *   - de 3 meses a 5 años                       → 1 mes
 *   - más de 5 años                             → 2 meses
 */
export function calcularPreaviso(sueldoMensual: number, mesesAntiguedad: number): number {
  if (sueldoMensual <= 0) return 0;
  if (mesesAntiguedad < 3) return (sueldoMensual / 30) * 15;
  if (mesesAntiguedad <= 60) return sueldoMensual;
  return sueldoMensual * 2;
}

/** Calcula liquidación final al egreso del empleado (LCT vigente). */
export function calcularLiquidacionFinal(params: LiquidacionFinalParams): LiquidacionFinalResult {
  const { sueldo_mensual, fecha_inicio, fecha_egreso, vacaciones_acumuladas, motivo } = params;

  const valorDia = sueldo_mensual / 30;
  const fechaEg = new Date(fecha_egreso + "T12:00:00");
  const diaDelMes = fechaEg.getDate();

  // ── Conceptos que se pagan SIEMPRE (cualquier motivo) ─────────────────────
  // Proporcional del mes trabajado.
  const proporcional_mes = valorDia * diaDelMes;

  // SAC proporcional del semestre en curso.
  // Cuenta los días EFECTIVAMENTE trabajados dentro del semestre: desde el más
  // tarde entre (inicio del semestre) y (fecha de ingreso del empleado), hasta
  // la fecha de egreso del cuadro, contando AMBAS puntas (inclusive).
  // Fix 09-jun (Lucas): antes arrancaba SIEMPRE el 1-ene/1-jul ignorando el
  // ingreso → inflaba el SAC de quien entró a mitad de semestre (Estrada:
  // ingreso 19-mar, egreso 31-may → contaba 159 días en vez de 74). La fecha de
  // egreso del cuadro es la que manda; los días del mes de egreso SÍ cuentan.
  const inicioSem = fechaEg.getMonth() < 6
    ? new Date(fechaEg.getFullYear(), 0, 1)
    : new Date(fechaEg.getFullYear(), 6, 1);
  const fechaIni = fecha_inicio ? new Date(fecha_inicio + "T12:00:00") : inicioSem;
  const arranqueSem = fechaIni.getTime() > inicioSem.getTime() ? fechaIni : inicioSem;
  const aDiaUTC = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const diasEnSem = Math.max(0, Math.floor((aDiaUTC(fechaEg) - aDiaUTC(arranqueSem)) / 86400000) + 1);
  const sac_proporcional = (sueldo_mensual / 2) * (diasEnSem / 180);

  // Vacaciones no gozadas en dinero (LCT Art 155: sueldo/25) + su SAC.
  const valor_dia_vacacional = sueldo_mensual / 25;
  const vacaciones_dinero = Math.max(0, vacaciones_acumuladas) * valor_dia_vacacional;
  const sac_vacaciones = vacaciones_dinero / 12;

  // ── Conceptos según el motivo ─────────────────────────────────────────────
  const esDespido = motivo === "Despido sin preaviso" || motivo === "Despido con preaviso";
  const sinPreaviso = motivo === "Despido sin preaviso";
  const mult = params.indemnizacion_mult ?? 1;
  const meses = mesesAntiguedadCompletos(fecha_inicio, fecha_egreso);
  const antiguedad_anios = aniosIndemnizatorios(fecha_inicio, fecha_egreso);

  // Indemnización por antigüedad (Art 245) — todo despido.
  const indemnizacion = esDespido ? sueldo_mensual * antiguedad_anios * mult : 0;

  // Preaviso (Art 232) + SAC — solo despido SIN preaviso.
  const preaviso = sinPreaviso ? calcularPreaviso(sueldo_mensual, meses) * mult : 0;
  const sac_preaviso = preaviso / 12;

  // Integración mes de despido (Art 233) + SAC — solo despido SIN preaviso.
  const diasRestantesMes = new Date(fechaEg.getFullYear(), fechaEg.getMonth() + 1, 0).getDate() - diaDelMes;
  const integracion_mes = sinPreaviso ? valorDia * diasRestantesMes * mult : 0;
  const sac_integracion = integracion_mes / 12;

  // Gratificación / extra manual (acuerdo mutuo, ajustes).
  const gratificacion = Math.max(0, params.gratificacion ?? 0);

  const total = Math.max(0,
    proporcional_mes + sac_proporcional + vacaciones_dinero + sac_vacaciones +
    indemnizacion + preaviso + sac_preaviso + integracion_mes + sac_integracion +
    gratificacion,
  );

  return {
    proporcional_mes,
    sac_proporcional,
    vacaciones_dinero,
    sac_vacaciones,
    indemnizacion,
    preaviso,
    sac_preaviso,
    integracion_mes,
    sac_integracion,
    gratificacion,
    total,
    antiguedad_anios,
  };
}
