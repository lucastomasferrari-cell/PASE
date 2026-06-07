// ─────────────────────────────────────────────────────────────────────────
// RECIBOS DE SUELDO — modelo + helpers (Lucas 04-jun)
//
// Arma el modelo de datos de un recibo de sueldo imprimible a partir de una
// liquidación pagada + sus movimientos (split efectivo/MP) + datos del
// empleado y del negocio. Pure y testeable; el render vive en
// components/recibos/ReciboSueldo.tsx.
// ─────────────────────────────────────────────────────────────────────────

const MESES = ["", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

// ── Número a letras (español, pesos enteros) ────────────────────────────────
const UNIDADES = ["", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
  "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve",
  "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve"];
const DECENAS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const CENTENAS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos",
  "seiscientos", "setecientos", "ochocientos", "novecientos"];

/** Convierte 0..999 a letras. `apocope` usa "un" en vez de "uno" (para miles/millones). */
function tresCifras(n: number, apocope = false): string {
  if (n === 0) return "";
  if (n === 100) return "cien";
  let out = "";
  const c = Math.floor(n / 100);
  const resto = n % 100;
  if (c > 0) out += CENTENAS[c]!;
  if (resto > 0) {
    if (out) out += " ";
    if (resto < 30) {
      out += resto === 1 && apocope ? "un" : UNIDADES[resto]!;
    } else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      out += DECENAS[d]!;
      if (u > 0) out += " y " + (u === 1 && apocope ? "un" : UNIDADES[u]!);
    }
  }
  return out;
}

/**
 * Número entero a letras en español (pesos). Soporta hasta 999.999.999.
 * Ej: 1014583 → "un millón catorce mil quinientos ochenta y tres".
 */
export function numeroALetras(num: number): string {
  const n = Math.floor(Math.abs(num));
  if (n === 0) return "cero";

  const millones = Math.floor(n / 1_000_000);
  const miles = Math.floor((n % 1_000_000) / 1000);
  const resto = n % 1000;

  const partes: string[] = [];

  if (millones > 0) {
    partes.push(millones === 1 ? "un millón" : tresCifras(millones, true) + " millones");
  }
  if (miles > 0) {
    partes.push(miles === 1 ? "mil" : tresCifras(miles, true) + " mil");
  }
  if (resto > 0) {
    partes.push(tresCifras(resto));
  }
  return partes.join(" ").trim();
}

// ── Modelo del recibo ───────────────────────────────────────────────────────
export interface ReciboConcepto {
  label: string;
  monto: number;
  signo: "+" | "-";
}
export interface ReciboPago {
  medio: string;   // "Efectivo" | "Mercado Pago" | nombre de cuenta
  monto: number;
}
export interface ReciboNegocio {
  razonSocial: string;
  cuit?: string | null;
  direccion?: string | null;
  sucursal?: string | null;
}
export interface ReciboEmpleado {
  nombre: string;     // "Apellido, Nombre"
  cuil?: string | null;
  puesto?: string | null;
  ingreso?: string | null; // fecha ISO
}
export interface ReciboSueldoModel {
  tipo: "mensual" | "final";
  negocio: ReciboNegocio;
  empleado: ReciboEmpleado;
  periodo: string;        // "Junio 2026" / "Q1 Junio 2026" / "Liquidación final"
  modo?: string;          // "Mensual" / "Quincenal" / etc
  conceptos: ReciboConcepto[];
  total: number;
  totalEnLetras: string;  // "... pesos"
  pagos: ReciboPago[];
  fechaPago?: string | null;
}

// ── Helpers de entrada ──────────────────────────────────────────────────────
export interface LiqParaRecibo {
  sueldo_base?: number | null;
  total_horas_extras?: number | null;
  total_dobles?: number | null;
  total_feriados?: number | null;
  total_vacaciones?: number | null;
  monto_presentismo?: number | null;
  descuento_ausencias?: number | null;
  otros_descuentos?: number | null;
  bono?: number | null;
  adelantos?: number | null;
  total_a_pagar?: number | null;
  pagos_realizados?: number | null;
  cuota_num?: number | null;
  cuotas_total?: number | null;
}
export interface MovParaRecibo {
  cuenta: string;
  importe: number; // negativo (egreso)
}

function clasificarMedio(cuenta: string): string {
  if (/efect/i.test(cuenta)) return "Efectivo";
  if (/mp|mercado/i.test(cuenta)) return "Mercado Pago";
  if (/banco|transfer/i.test(cuenta)) return "Transferencia";
  return cuenta;
}

/** Agrupa los movimientos de una liquidación en medios de pago (monto positivo). */
export function splitPagos(movs: MovParaRecibo[]): ReciboPago[] {
  const map = new Map<string, number>();
  for (const m of movs) {
    const medio = clasificarMedio(m.cuenta);
    map.set(medio, (map.get(medio) ?? 0) + Math.abs(Number(m.importe || 0)));
  }
  return Array.from(map.entries()).map(([medio, monto]) => ({ medio, monto }));
}

function periodoMensual(mes: number, anio: number, cuotaNum?: number | null, cuotasTotal?: number | null): string {
  const base = `${MESES[mes] ?? ""} ${anio}`.trim();
  if (cuotasTotal && cuotasTotal > 1 && cuotaNum) return `${cuotaNum === 1 ? "Q1" : "Q2"} ${base}`;
  return base;
}

/** Arma el modelo de recibo de un sueldo MENSUAL pagado. */
export function construirReciboMensual(args: {
  liq: LiqParaRecibo;
  movs: MovParaRecibo[];
  empleado: ReciboEmpleado;
  negocio: ReciboNegocio;
  mes: number;
  anio: number;
  modo?: string;
  fechaPago?: string | null;
}): ReciboSueldoModel {
  const { liq, movs, empleado, negocio, mes, anio, modo, fechaPago } = args;
  const num = (v: number | null | undefined) => Math.round(Number(v || 0));

  const conceptos: ReciboConcepto[] = [];
  conceptos.push({ label: "Sueldo base", monto: num(liq.sueldo_base), signo: "+" });
  if (num(liq.total_horas_extras) !== 0) conceptos.push({ label: "Horas extras", monto: num(liq.total_horas_extras), signo: num(liq.total_horas_extras) >= 0 ? "+" : "-" });
  if (num(liq.total_dobles) > 0) conceptos.push({ label: "Dobles", monto: num(liq.total_dobles), signo: "+" });
  if (num(liq.total_feriados) > 0) conceptos.push({ label: "Feriados", monto: num(liq.total_feriados), signo: "+" });
  if (num(liq.total_vacaciones) > 0) conceptos.push({ label: "Plus vacacional", monto: num(liq.total_vacaciones), signo: "+" });
  if (num(liq.monto_presentismo) > 0) conceptos.push({ label: "Presentismo", monto: num(liq.monto_presentismo), signo: "+" });
  if (num(liq.bono) > 0) conceptos.push({ label: "Bono", monto: num(liq.bono), signo: "+" });
  if (num(liq.descuento_ausencias) > 0) conceptos.push({ label: "Faltas", monto: num(liq.descuento_ausencias), signo: "-" });
  if (num(liq.otros_descuentos) > 0) conceptos.push({ label: "Otros descuentos", monto: num(liq.otros_descuentos), signo: "-" });
  if (num(liq.adelantos) > 0) conceptos.push({ label: "Adelantos", monto: num(liq.adelantos), signo: "-" });

  const pagos = splitPagos(movs);
  // El total del recibo es lo realmente pagado (suma de movimientos) si hay;
  // si no, el total_a_pagar de la liquidación.
  const totalPagado = pagos.reduce((s, p) => s + p.monto, 0);
  const total = totalPagado > 0 ? totalPagado : num(liq.total_a_pagar);

  return {
    tipo: "mensual",
    negocio,
    empleado,
    periodo: periodoMensual(mes, anio, liq.cuota_num, liq.cuotas_total),
    modo,
    conceptos,
    total,
    totalEnLetras: numeroALetras(total) + " pesos",
    pagos,
    fechaPago: fechaPago ?? null,
  };
}

/** Arma el modelo de recibo de una LIQUIDACIÓN FINAL. */
export function construirReciboFinal(args: {
  conceptos: ReciboConcepto[];
  total: number;
  movs: MovParaRecibo[];
  empleado: ReciboEmpleado;
  negocio: ReciboNegocio;
  motivo: string;
  fechaEgreso: string;
  fechaPago?: string | null;
}): ReciboSueldoModel {
  const { conceptos, total, movs, empleado, negocio, motivo, fechaEgreso, fechaPago } = args;
  const pagos = splitPagos(movs);
  return {
    tipo: "final",
    negocio,
    empleado,
    periodo: `Liquidación final — ${motivo} (egreso ${fechaEgreso})`,
    conceptos,
    total: Math.round(total),
    totalEnLetras: numeroALetras(total) + " pesos",
    pagos,
    fechaPago: fechaPago ?? null,
  };
}
