/**
 * Parser local del CSV "account_statement" que descarga MercadoPago una vez
 * al mes desde el panel web.
 *
 * Formato (verificado con extracto real abril 2026):
 *   INITIAL_BALANCE;CREDITS;DEBITS;FINAL_BALANCE       ← header resumen
 *   {n};{n};{n};{n}                                    ← fila resumen
 *                                                       ← LÍNEA VACÍA
 *   RELEASE_DATE;TRANSACTION_TYPE;REFERENCE_ID;TRANSACTION_NET_AMOUNT;PARTIAL_BALANCE
 *   {DD-MM-YYYY};{texto};{id};{n con signo};{n}
 *   ...
 *
 * Notas:
 * - Números en formato AR (puntos miles, coma decimal).
 * - Egresos vienen con signo - en TRANSACTION_NET_AMOUNT.
 * - Fechas DD-MM-YYYY (no ISO).
 * - TRANSACTION_TYPE es texto libre. Ej.:
 *     "Rendimientos ", "Pago de servicio Metrogas",
 *     "Transferencia enviada Distribuidora De Bebidas Srl",
 *     "Transferencia recibida LUCAS TOMAS FERRARI",
 *     "Liquidación de dinero ", "Pago RAPPI ARG SAS",
 *     "Compra Mercado Libre", "Liquidación de dinero cancelada Venta cancelada",
 *     "Pago de suscripción Max", "Débito por deuda Facturas vencidas de Mercado Libre",
 *     "Devolución de compra Mercado Libre", "Devolución de transferencia enviada ...",
 *     "Dinero recibido Regalo Excepcional Mercado Pago"
 *
 * Ventaja vs Claude IA:
 * - Gratis (sin costo API)
 * - 100% precisión (sin alucinaciones)
 * - Instantáneo (sin API call)
 *
 * Si Lucas tiene el CSV exacto del panel, este parser le da resultado en ms.
 * Si solo tiene PDF/imagen, cae al lector IA (mismo shape de output).
 */

import type { CashflowExtractoParseado } from "./cashflowExtracto";

export interface ExtractoMovimiento {
  fecha: string;          // YYYY-MM-DD (normalizado desde DD-MM-YYYY)
  monto: number;          // signed
  tipo: string;           // categoría derivada del TRANSACTION_TYPE
  descripcion: string;    // TRANSACTION_TYPE crudo (texto libre del CSV)
  referencia_externa: string | null;
}

export interface ExtractoResultado {
  movimientos: ExtractoMovimiento[];
  total_movimientos: number;
  rango_fechas: { desde: string; hasta: string };
  /** Resumen del header del CSV (si está presente). */
  resumen?: {
    initial_balance: number;
    credits: number;
    debits: number;
    final_balance: number;
  };
  /** Siempre 1.0 porque es parsing exacto (no IA). */
  confianza_global: number;
  advertencias: string[];
}

const HEADER_RESUMEN_FIELDS = ["INITIAL_BALANCE", "CREDITS", "DEBITS", "FINAL_BALANCE"];
const HEADER_MOV_FIELDS = ["RELEASE_DATE", "TRANSACTION_TYPE", "REFERENCE_ID", "TRANSACTION_NET_AMOUNT", "PARTIAL_BALANCE"];

/**
 * Convierte número formato AR ("1.234,56" o "-100,50") a number.
 * Tolerante: si ya viene como float o entero, lo deja pasar.
 */
function parseMontoAr(s: string): number {
  if (!s || s.trim() === "") return 0;
  // AR: punto miles, coma decimal → quitar puntos, reemplazar coma por punto.
  const normalized = s.trim().replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function parseFechaAr(s: string): string | null {
  // "01-04-2026" → "2026-04-01"
  const m = s.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
}

/**
 * Categoriza un TRANSACTION_TYPE crudo en un tipo abstracto que usamos en
 * mp_movimientos. Lower-case + trim para matching.
 */
function categorizarTipo(transType: string): string {
  const t = transType.toLowerCase().trim();
  if (t.includes("rendimientos")) return "rendimiento";
  if (t.includes("transferencia enviada")) return "transferencia_egreso";
  if (t.includes("transferencia recibida")) return "transferencia_ingreso";
  if (t.includes("devolución de transferencia")) return "devolucion";
  if (t.includes("devolución de compra")) return "devolucion";
  if (t.includes("liquidación de dinero cancelada")) return "liquidacion_cancelada";
  if (t.includes("liquidación de dinero")) return "liquidacion";
  if (t.includes("pago de servicio")) return "pago_servicio";
  if (t.includes("pago de suscripción")) return "pago_servicio";
  if (t.includes("pago rappi")) return "comision_delivery";
  if (t.includes("pago disco")) return "compra";
  if (t.includes("compra mercado libre")) return "compra";
  if (t.includes("pago personal")) return "pago_servicio";
  if (t.includes("débito por deuda")) return "debito";
  if (t.includes("dinero recibido")) return "regalo";
  if (t.startsWith("pago ")) return "pago_otro";
  return "otro";
}

/**
 * Parsea el contenido completo del CSV. Devuelve null si el formato no
 * matchea (el caller decide caer a Claude IA o mostrar error).
 */
export function parseExtractoMP(csvText: string): ExtractoResultado | null {
  if (!csvText) return null;

  // Strip BOM si hay.
  let s = csvText;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  const lines = s.split(/\r?\n/);
  if (lines.length < 4) return null;

  // Detectar el header de RESUMEN (línea 1) — opcional, validamos pero no
  // crítico para procesar movs.
  let resumen: ExtractoResultado["resumen"] | undefined;
  const resumenHeaderIdx = lines.findIndex(l => {
    const cols = l.split(";");
    return cols.length >= 4 && HEADER_RESUMEN_FIELDS.every(h => cols.includes(h));
  });
  if (resumenHeaderIdx >= 0 && resumenHeaderIdx + 1 < lines.length) {
    const cols = lines[resumenHeaderIdx + 1]!.split(";");
    if (cols.length >= 4) {
      resumen = {
        initial_balance: parseMontoAr(cols[0]!),
        credits: parseMontoAr(cols[1]!),
        debits: parseMontoAr(cols[2]!),
        final_balance: parseMontoAr(cols[3]!),
      };
    }
  }

  // Encontrar el header de MOVIMIENTOS.
  const movHeaderIdx = lines.findIndex(l => {
    const cols = l.split(";");
    return cols.length >= 5 && HEADER_MOV_FIELDS.every(h => cols.includes(h));
  });
  if (movHeaderIdx < 0) return null;

  const headerCols = lines[movHeaderIdx]!.split(";").map(s => s.trim());
  const colIdx = {
    fecha: headerCols.indexOf("RELEASE_DATE"),
    tipo: headerCols.indexOf("TRANSACTION_TYPE"),
    refId: headerCols.indexOf("REFERENCE_ID"),
    monto: headerCols.indexOf("TRANSACTION_NET_AMOUNT"),
  };
  if (colIdx.fecha < 0 || colIdx.tipo < 0 || colIdx.monto < 0) return null;

  const advertencias: string[] = [];
  const movimientos: ExtractoMovimiento[] = [];

  for (let i = movHeaderIdx + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    const cols = line.split(";");
    if (cols.length < 4) {
      advertencias.push(`Línea ${i + 1}: solo ${cols.length} columnas, esperaba ≥5. Saltada.`);
      continue;
    }
    const fechaRaw = cols[colIdx.fecha]!;
    const tipoRaw = (cols[colIdx.tipo] ?? "").trim();
    const refRaw = (cols[colIdx.refId] ?? "").trim();
    const montoRaw = cols[colIdx.monto]!;

    const fecha = parseFechaAr(fechaRaw);
    if (!fecha) {
      advertencias.push(`Línea ${i + 1}: fecha inválida "${fechaRaw}". Saltada.`);
      continue;
    }
    const monto = parseMontoAr(montoRaw);
    if (monto === 0) {
      advertencias.push(`Línea ${i + 1}: monto cero o no parseable "${montoRaw}". Saltada.`);
      continue;
    }

    movimientos.push({
      fecha,
      monto,
      tipo: categorizarTipo(tipoRaw),
      descripcion: tipoRaw,
      referencia_externa: refRaw || null,
    });
  }

  if (movimientos.length === 0) return null;

  // Rango de fechas (los movimientos están ordenados cronológicamente en MP
  // pero no asumimos — sortamos para seguridad).
  const fechasSorted = movimientos.map(m => m.fecha).sort();
  const rango_fechas = {
    desde: fechasSorted[0]!,
    hasta: fechasSorted[fechasSorted.length - 1]!,
  };

  // Sanity check: si tenemos resumen, validar que la suma de débitos+créditos
  // matchee aproximadamente con CREDITS+DEBITS del header. Tolerancia 1%.
  if (resumen) {
    const credSum = movimientos.filter(m => m.monto > 0).reduce((s, m) => s + m.monto, 0);
    const debSum  = movimientos.filter(m => m.monto < 0).reduce((s, m) => s + m.monto, 0);
    const credDiff = Math.abs(credSum - resumen.credits);
    const debDiff  = Math.abs(debSum - resumen.debits);
    if (credDiff > Math.abs(resumen.credits) * 0.01) {
      advertencias.push(`Suma de créditos parseados ($${credSum.toFixed(2)}) difiere del header CREDITS ($${resumen.credits.toFixed(2)}).`);
    }
    if (debDiff > Math.abs(resumen.debits) * 0.01) {
      advertencias.push(`Suma de débitos parseados ($${debSum.toFixed(2)}) difiere del header DEBITS ($${resumen.debits.toFixed(2)}).`);
    }
  }

  return {
    movimientos,
    total_movimientos: movimientos.length,
    rango_fechas,
    resumen,
    confianza_global: 1.0,
    advertencias,
  };
}

/**
 * Adapta el resultado del parser MP al contrato común del módulo Cashflow.
 *
 * MVP (decisión documentada en el plan, Task 3): el account_statement de MP da
 * el NETO por línea; el detalle bruto/comisión vive en el "settlement report"
 * (otro archivo). Por eso acá `monto_bruto` = neto y `comision`/`retencion`
 * quedan en 0 a nivel línea. La comisión total se estima/carga como categoría
 * aparte. Migrar a bruto/fee desagregado es mejora de fase 2.
 *
 * `saldoInicial`/`saldoFinal` salen de la fila de resumen del extracto
 * (INITIAL_BALANCE / FINAL_BALANCE). Si el extracto no la trae, quedan en 0.
 */
export function mpResultadoParaCashflow(r: ExtractoResultado): CashflowExtractoParseado {
  return {
    saldoInicial: r.resumen?.initial_balance ?? 0,
    saldoFinal: r.resumen?.final_balance ?? 0,
    lineas: r.movimientos.map(m => ({
      fecha: m.fecha,
      descripcion: m.descripcion,
      monto_bruto: m.monto,
      comision: 0,
      retencion: 0,
    })),
    ...(r.advertencias.length > 0 ? { advertencias: r.advertencias } : {}),
  };
}

/**
 * Conveniencia para la pantalla: lee el archivo XLSX/XLS de MP y lo devuelve ya
 * adaptado al shape del cashflow. Devuelve null si el archivo no parsea (el
 * caller decide mostrar error o caer a carga manual).
 */
export async function mpLineasParaCashflow(file: File): Promise<CashflowExtractoParseado | null> {
  const r = await parseExtractoMpExcel(file);
  return r ? mpResultadoParaCashflow(r) : null;
}

/**
 * Detecta si un archivo es probablemente un account_statement CSV de MP.
 * No falla si es PDF/imagen — devuelve false para que el caller use Claude IA.
 */
export function esExtractoMpCsv(file: File): Promise<boolean> {
  return new Promise(resolve => {
    if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
      resolve(false);
      return;
    }
    // Leer solo los primeros 2KB para detectar headers.
    const slice = file.slice(0, 2048);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const hasMovHeader = HEADER_MOV_FIELDS.every(h => text.includes(h));
      resolve(hasMovHeader);
    };
    reader.onerror = () => resolve(false);
    reader.readAsText(slice);
  });
}

/**
 * Detecta si un archivo es probablemente un account_statement XLSX de MP.
 * MP entrega el mismo formato que el CSV pero dentro de un Excel.
 * No verifica el contenido (eso lo hace el parser): solo extension.
 */
export function esExtractoMpExcel(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".xlsx")
    || name.endsWith(".xls")
    || file.type === "application/vnd.ms-excel"
    || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

/**
 * Lee un archivo XLSX/XLS de MP y lo convierte a texto CSV-compatible que
 * el parser principal `parseExtractoMP` sabe leer. Reusa toda la lógica de
 * parsing del CSV — XLSX es solo un envoltorio del mismo formato.
 *
 * El XLSX de MP tiene UNA hoja "sheet0" con la misma estructura del CSV:
 *   Fila 0: INITIAL_BALANCE | CREDITS | DEBITS | FINAL_BALANCE
 *   Fila 1: valores
 *   Fila 2: en blanco
 *   Fila 3: RELEASE_DATE | TRANSACTION_TYPE | REFERENCE_ID | TRANSACTION_NET_AMOUNT | PARTIAL_BALANCE
 *   Filas 4+: movimientos
 *
 * Usa la lib `xlsx` (SheetJS) para abrir el archivo. Tree-shaking parcial:
 * solo importamos `read` y `utils.sheet_to_csv`.
 *
 * Si el archivo no tiene la estructura esperada, devuelve null y el caller
 * cae a Claude IA o muestra error.
 */
export async function parseExtractoMpExcel(file: File): Promise<ExtractoResultado | null> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", raw: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return null;
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return null;
  // Convertimos a CSV con ; como separador (mismo formato que el CSV original).
  // FS=";" → field separator. raw:false ya pasó por formato de texto.
  const csv = XLSX.utils.sheet_to_csv(sheet, { FS: ";", strip: false });
  return parseExtractoMP(csv);
}
