// Cálculo del aguinaldo (SAC) proporcional al tiempo trabajado en el semestre.
// Lucas 22-jun: el que entró a mitad de semestre cobra la parte proporcional,
// no el medio sueldo completo.
//
//   aguinaldo = (sueldo_mensual / 2) * (días trabajados en el semestre / días del semestre)
//
// Días trabajados = desde el ingreso (si cae dentro del semestre) hasta el fin
// del semestre (30/jun para ene-jun, 31/dic para jul-dic). Si trabajó todo el
// semestre → medio sueldo completo. Si ingresó después del fin del semestre → 0.

export interface AguinaldoCalc {
  /** Aguinaldo proporcional, redondeado. */
  monto: number;
  /** Fracción del semestre trabajada (0..1). */
  fraccion: number;
  diasTrabajados: number;
  diasSemestre: number;
  /** true si NO trabajó el semestre completo (cobra proporcional). */
  parcial: boolean;
}

const MS_DIA = 86_400_000;

/** Parsea "YYYY-MM-DD" a un Date en UTC (medianoche). null/ inválida → null. */
function parseISOUTC(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s.slice(0, 10) + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}

/**
 * @param sueldoMensual sueldo mensual declarado del legajo
 * @param fechaInicio   "YYYY-MM-DD" de ingreso (null = se asume semestre completo)
 * @param fechaRef      fecha de pago — define el semestre (ene-jun / jul-dic)
 */
export function calcularAguinaldo(
  sueldoMensual: number,
  fechaInicio: string | null,
  fechaRef: Date,
): AguinaldoCalc {
  const anio = fechaRef.getFullYear();
  const sem1 = fechaRef.getMonth() <= 5; // 0-5 = ene-jun
  const semIni = new Date(Date.UTC(anio, sem1 ? 0 : 6, 1));
  const semFin = sem1 ? new Date(Date.UTC(anio, 5, 30)) : new Date(Date.UTC(anio, 11, 31));
  const diasSemestre = Math.round((semFin.getTime() - semIni.getTime()) / MS_DIA) + 1;

  // Inicio efectivo = el más tardío entre ingreso y comienzo del semestre.
  const ingreso = parseISOUTC(fechaInicio);
  const inicio = ingreso && ingreso.getTime() > semIni.getTime() ? ingreso : semIni;

  let diasTrabajados = 0;
  if (inicio.getTime() <= semFin.getTime()) {
    diasTrabajados = Math.round((semFin.getTime() - inicio.getTime()) / MS_DIA) + 1;
  }
  if (diasTrabajados > diasSemestre) diasTrabajados = diasSemestre;
  if (diasTrabajados < 0) diasTrabajados = 0;

  const fraccion = diasSemestre > 0 ? diasTrabajados / diasSemestre : 0;
  const monto = Math.round((sueldoMensual / 2) * fraccion);
  const parcial = diasTrabajados < diasSemestre;
  return { monto, fraccion, diasTrabajados, diasSemestre, parcial };
}
