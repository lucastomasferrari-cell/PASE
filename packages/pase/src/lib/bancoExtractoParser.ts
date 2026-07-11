/**
 * Parser del resumen de cuenta de BBVA (cuenta de Rene/Baldi) para el módulo
 * Cashflow.
 *
 * BBVA entrega el resumen como PDF. La pieza de negocio (este archivo) opera
 * sobre el TEXTO ya extraído del PDF — así es testeable sin pdfjs. La extracción
 * del texto en el browser vive en `extraerTextoPdf` (glue con pdfjs-dist).
 *
 * Formato real (verificado con resumen mayo 2026, cuenta CC 005-092854/9):
 *
 *   FECHA ORIGEN CONCEPTO DÉBITO CRÉDITO SALDO
 *   SALDO ANTERIOR 0,00
 *   04/05 D 733 TRANSFERENCIA 26916987 3.500,00 3.500,00
 *   05/05 LEY NRO 25.413 SOBRE CREDIT -397,73 65.892,27
 *   06/05 D CUPONES PRISMA 70907-0001870260 215.077,19 505.511,96
 *   ...
 *   SALDO AL 08 DE MAYO 1.817.391,59
 *
 * Decisiones clave:
 * - Cada movimiento empieza con `DD/MM`. Las líneas que no (headers de columna
 *   repetidos entre páginas, número de sobre, texto vertical mal extraído,
 *   "TOTAL MOVIMIENTOS", leyendas legales) se ignoran.
 * - El texto del PDF COLAPSA las columnas Débito/Crédito (la vacía desaparece),
 *   así que NO se puede distinguir signo por columna. El signo se deriva del
 *   **delta del SALDO corrido** (la última columna), que nunca miente y además
 *   auto-valida: |saldo_i − saldo_{i-1}| debe igualar el monto impreso.
 * - El año no viene por línea (solo DD/MM) → se pasa como parámetro del período.
 * - `saldoInicial` = "SALDO ANTERIOR". `saldoFinal` = último saldo corrido
 *   (se cruza contra "SALDO AL …" si está; discrepancia → advertencia, no corta).
 */

import type { CashflowExtractoParseado, CashflowLineaCargada } from "./cashflowExtracto";

/** "1.234,56" / "-397,73" (formato AR) → number. Tolerante. */
function parseMontoAr(s: string): number {
  if (!s || s.trim() === "") return 0;
  const normalized = s.trim().replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

// Una línea de movimiento: DD/MM <concepto> <monto,dd> <saldo,dd> (fin de línea).
// El concepto es no-greedy; los dos montos finales exigen coma+2 decimales, así
// que los IDs/referencias enteras (sin coma) quedan dentro del concepto.
const MOV_RE = /^(\d{2})\/(\d{2})\s+(.+?)\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})$/;
const SALDO_ANTERIOR_RE = /SALDO ANTERIOR\s+(-?[\d.]+,\d{2})/i;
const SALDO_AL_RE = /SALDO AL\b.*?(-?[\d.]+,\d{2})\s*$/i;

/**
 * Parsea el texto de un resumen BBVA y devuelve el extracto en el contrato común
 * del cashflow. `anio` es el año del período (el resumen solo trae DD/MM).
 */
export function parseExtractoBanco(texto: string, anio: number): CashflowExtractoParseado {
  const advertencias: string[] = [];
  // Robustez de extracción: algunos extractores (pdfjs en el browser) agrupan
  // dos movimientos en una misma línea cuando sus coordenadas Y redondean igual.
  // Un saldo (`…,dd`) seguido de una fecha `DD/MM` marca el inicio de otro
  // movimiento → insertamos un salto de línea ahí para separarlos.
  const normalizado = texto.replace(/(,\d{2})\s+(\d{2}\/\d{2}\s)/g, "$1\n$2");
  const lineasTexto = normalizado.split(/\r?\n/).map(l => l.trim());

  // Saldo de apertura.
  let saldoInicial = 0;
  const anterior = texto.match(SALDO_ANTERIOR_RE);
  if (anterior) {
    saldoInicial = parseMontoAr(anterior[1]!);
  } else {
    advertencias.push("No se encontró 'SALDO ANTERIOR'; se asume saldo inicial 0.");
  }

  const lineas: CashflowLineaCargada[] = [];
  let saldoPrev = saldoInicial;
  let saldoCorrido = saldoInicial;

  for (const linea of lineasTexto) {
    const m = MOV_RE.exec(linea);
    if (!m) continue;
    const [, dd, mm, conceptoRaw, montoRaw, saldoRaw] = m;

    const saldoActual = parseMontoAr(saldoRaw!);
    const monto = Math.round((saldoActual - saldoPrev) * 100) / 100;
    const montoImpreso = parseMontoAr(montoRaw!);

    // Cruce: el delta de saldo debe igualar (en magnitud) el monto impreso.
    if (Math.abs(Math.abs(monto) - Math.abs(montoImpreso)) > 0.01) {
      advertencias.push(
        `Línea ${dd}/${mm}: el delta de saldo ($${monto.toFixed(2)}) no coincide con el monto impreso ($${montoImpreso.toFixed(2)}).`,
      );
    }

    lineas.push({
      fecha: `${anio}-${mm}-${dd}`,
      descripcion: conceptoRaw!.replace(/\s+/g, " ").trim(),
      monto_bruto: monto,
      comision: 0,
      retencion: 0,
    });

    saldoPrev = saldoActual;
    saldoCorrido = saldoActual;
  }

  // Saldo de cierre: manda el saldo corrido real. Si el resumen declara un
  // "SALDO AL …" que no coincide, se avisa (pero no se corta).
  const saldoFinal = lineas.length > 0 ? saldoCorrido : saldoInicial;
  const declarado = texto.match(SALDO_AL_RE);
  if (declarado) {
    const saldoDeclarado = parseMontoAr(declarado[1]!);
    if (Math.abs(saldoDeclarado - saldoFinal) > 0.01) {
      advertencias.push(
        `El saldo de cierre declarado ($${saldoDeclarado.toFixed(2)}) no coincide con el saldo corrido derivado ($${saldoFinal.toFixed(2)}).`,
      );
    }
  }

  return {
    saldoInicial,
    saldoFinal,
    lineas,
    ...(advertencias.length > 0 ? { advertencias } : {}),
  };
}

/* ==========================================================================
 * Banco GALICIA — "Resumen de Caja de Ahorro en Pesos"
 * ==========================================================================
 * Formato distinto al de BBVA (lo usa Neko Villa Crespo, cuenta a nombre de
 * Lucas Ferrari). Verificado con el resumen real de junio 2026:
 *
 *   Fecha Descripción Origen Crédito Débito Saldo
 *   01/06/26 REINTEGRO PROMOCION GALICIA 2.750,00 2.165.329,40
 *   01/06/26 ING. BRUTOS S/ CRED -20.613,27 3.175.379,71
 *   ...
 *
 * Diferencias clave con BBVA:
 * - La fecha es DD/MM/YY (trae el año, a diferencia de BBVA que era DD/MM).
 * - Cada movimiento trae DOS números al final: monto y saldo corrido. Los
 *   débitos vienen con signo `-` explícito; los créditos sin signo. Igual que
 *   BBVA, el signo REAL se deriva del delta del saldo corrido (nunca miente) y
 *   se cruza contra el monto impreso.
 * - Debajo de cada movimiento hay líneas de detalle (origen, CBU, CUIT) sin
 *   fecha → se ignoran (no matchean el patrón).
 * - No hay "SALDO ANTERIOR": el saldo inicial se deriva del primer movimiento
 *   (saldo − monto). El cierre se cruza contra el saldo que declara el encabezado
 *   junto al período (si está).
 */

// DD/MM/YY <concepto> <monto,dd> <saldo,dd> (fin de línea). Concepto no-greedy;
// los dos montos finales exigen coma+2 decimales.
const GAL_MOV_RE = /^(\d{2})\/(\d{2})\/(\d{2})\s+(.+?)\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})$/;
// Saldo declarado junto al período: "... 29/05/2026 26/06/2026 $2.025.303,46".
const GAL_CIERRE_RE = /\d{2}\/\d{2}\/\d{4}\s+\d{2}\/\d{2}\/\d{4}\s+\$?\s*(-?[\d.]+,\d{2})/;

/**
 * Parsea el texto de un resumen Galicia y lo devuelve en el contrato común del
 * cashflow. `anio` queda para compat de firma con `parseExtractoBanco`, pero el
 * año real sale del DD/MM/**YY** de cada línea.
 */
export function parseExtractoBancoGalicia(texto: string, _anio: number): CashflowExtractoParseado {
  const advertencias: string[] = [];
  // Separar dos movimientos pegados en una misma fila (un saldo `…,dd` seguido de
  // una fecha DD/MM/YY marca el inicio de otro movimiento).
  const normalizado = texto.replace(/(,\d{2})\s+(\d{2}\/\d{2}\/\d{2}\s)/g, "$1\n$2");
  const lineasTexto = normalizado.split(/\r?\n/).map(l => l.trim());

  const crudos: { dd: string; mm: string; yy: string; concepto: string; montoImpreso: number; saldo: number }[] = [];
  for (const linea of lineasTexto) {
    const m = GAL_MOV_RE.exec(linea);
    if (!m) continue;
    const [, dd, mm, yy, conceptoRaw, montoRaw, saldoRaw] = m;
    crudos.push({
      dd: dd!, mm: mm!, yy: yy!,
      concepto: conceptoRaw!.replace(/\s+/g, " ").trim(),
      montoImpreso: parseMontoAr(montoRaw!),
      saldo: parseMontoAr(saldoRaw!),
    });
  }

  if (crudos.length === 0) {
    advertencias.push("No se encontraron movimientos con formato Galicia (DD/MM/YY … monto saldo).");
    return { saldoInicial: 0, saldoFinal: 0, lineas: [], advertencias };
  }

  // Saldo inicial = saldo del primer movimiento − su monto impreso (con signo).
  const saldoInicial = Math.round((crudos[0]!.saldo - crudos[0]!.montoImpreso) * 100) / 100;

  const lineas: CashflowLineaCargada[] = [];
  let saldoPrev = saldoInicial;
  for (const c of crudos) {
    // Fuente de verdad del monto = delta del saldo corrido.
    const monto = Math.round((c.saldo - saldoPrev) * 100) / 100;
    if (Math.abs(Math.abs(monto) - Math.abs(c.montoImpreso)) > 0.01) {
      advertencias.push(
        `Línea ${c.dd}/${c.mm}: el delta de saldo ($${monto.toFixed(2)}) no coincide con el monto impreso ($${c.montoImpreso.toFixed(2)}).`,
      );
    }
    lineas.push({
      fecha: `20${c.yy}-${c.mm}-${c.dd}`,
      descripcion: c.concepto,
      monto_bruto: monto,
      comision: 0,
      retencion: 0,
    });
    saldoPrev = c.saldo;
  }

  const saldoFinal = crudos[crudos.length - 1]!.saldo;

  // Cruce contra el saldo de cierre declarado en el encabezado (si aparece).
  const declarado = texto.match(GAL_CIERRE_RE);
  if (declarado) {
    const saldoDeclarado = parseMontoAr(declarado[1]!);
    if (Math.abs(saldoDeclarado - saldoFinal) > 0.01) {
      advertencias.push(
        `El saldo de cierre declarado ($${saldoDeclarado.toFixed(2)}) no coincide con el saldo corrido derivado ($${saldoFinal.toFixed(2)}).`,
      );
    }
  }

  return { saldoInicial, saldoFinal, lineas, ...(advertencias.length > 0 ? { advertencias } : {}) };
}

/* ==========================================================================
 * Extracción de texto del PDF (browser, pdfjs) + detección de formato
 * ========================================================================== */

/**
 * Reconstruye las líneas de texto de un PDF de banco agrupando los fragmentos de
 * pdfjs por coordenada Y (pdfjs entrega ítems posicionados, no líneas) y
 * ordenando por X. Import perezoso de pdfjs (~1MB) para no inflar el bundle.
 *
 * `recortarGlifos` activa el recorte de basura antes de la primera fecha DD/MM
 * (necesario para BBVA, donde un glifo mal decodificado ancla la fila). NO se usa
 * para Galicia: ahí las fechas son DD/MM/YY y el recorte leería "MM/YY" como una
 * fecha falsa y se comería el día. Browser-only.
 */
async function extraerFilasPdf(file: File, recortarGlifos: boolean): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  // El worker se sirve como asset propio (Vite resuelve la URL en build).
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const paginas: string[] = [];

  // Tolerancia de agrupación por fila. Los ítems de una misma fila se reportan
  // con Y que difiere por sub-píxeles; agrupar por Y EXACTA los separa (rompe
  // movimientos). Las filas reales están a ~12 de distancia, así que 4 reúne la
  // fila sin fusionar filas distintas.
  const TOL = 4;

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    // Ítems con posición (X, Y), de arriba→abajo, izquierda→derecha.
    const items: { x: number; y: number; str: string }[] = [];
    for (const item of content.items) {
      if (!("str" in item) || item.str.trim() === "") continue;
      const tr = item.transform as number[];
      items.push({ y: (tr[5] ?? 0) as number, x: (tr[4] ?? 0) as number, str: item.str });
    }
    items.sort((a, b) => b.y - a.y || a.x - b.x);

    // Agrupar en filas por Y con tolerancia.
    const filas: { y: number; items: { x: number; str: string }[] }[] = [];
    let actual: { y: number; items: { x: number; str: string }[] } | null = null;
    for (const it of items) {
      if (actual && Math.abs(it.y - actual.y) <= TOL) actual.items.push(it);
      else { actual = { y: it.y, items: [it] }; filas.push(actual); }
    }

    const lineasPagina = filas.map(f => {
      const base = f.items
        .sort((a, b) => a.x - b.x)
        .map(it => it.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      // Recortar glifos basura antes de la primera fecha DD/MM (solo BBVA).
      return recortarGlifos ? base.replace(/^.*?(?=\d{2}\/\d{2}\s)/, "") : base;
    });
    paginas.push(lineasPagina.join("\n"));
  }

  return paginas.join("\n");
}

/**
 * Extrae el texto de un PDF de resumen BBVA (con recorte de glifos). Se mantiene
 * exportada por compatibilidad — el path que usa la pantalla es
 * `bancoLineasParaCashflow`, que autodetecta el banco.
 */
export async function extraerTextoPdf(file: File): Promise<string> {
  return extraerFilasPdf(file, true);
}

/** ¿El texto extraído tiene pinta de resumen Galicia? (≥3 líneas DD/MM/YY … monto saldo). */
function pareceGalicia(texto: string): boolean {
  let hits = 0;
  for (const l of texto.split(/\r?\n/)) {
    if (GAL_MOV_RE.test(l.trim())) hits++;
    if (hits >= 3) return true;
  }
  return false;
}

/**
 * Conveniencia para la pantalla: extrae el texto del PDF, DETECTA el banco
 * (Galicia vs BBVA) y lo parsea con el parser correcto en un paso.
 * `anio` es el año del período (lo usa BBVA, que solo trae DD/MM).
 */
export async function bancoLineasParaCashflow(file: File, anio: number): Promise<CashflowExtractoParseado> {
  // Extracción sin recorte: sirve tal cual para Galicia y para detectar formato.
  const textoSinRecorte = await extraerFilasPdf(file, false);
  if (pareceGalicia(textoSinRecorte)) {
    return parseExtractoBancoGalicia(textoSinRecorte, anio);
  }
  // BBVA necesita el recorte de glifos → re-extraemos con recorte.
  const textoBbva = await extraerFilasPdf(file, true);
  return parseExtractoBanco(textoBbva, anio);
}
