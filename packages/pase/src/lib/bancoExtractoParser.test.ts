import { describe, it, expect } from "vitest";
import { parseExtractoBanco, parseExtractoBancoGalicia } from "./bancoExtractoParser";

/**
 * Fixture REAL: bloque DETALLE del resumen BBVA de Rene (cuenta Baldi Antonella,
 * CC 005-092854/9), período mayo 2026, extraído del PDF con la capa de texto.
 * Incluye el ruido real que aparece entre páginas (header de columnas repetido,
 * número de sobre, texto vertical mal extraído) para verificar que el parser lo
 * ignora. El saldo corre de SALDO ANTERIOR 0,00 hasta 1.817.391,59.
 */
const SAMPLE_BBVA_MAYO = `FECHA ORIGEN CONCEPTO DEBITO CREDITO SALDO
SALDO ANTERIOR 0,00
04/05 D 733 TRANSFERENCIA 26916987 3.500,00 3.500,00
04/05 D 733 TRANSFERENCIA 28909432 15.502,50 19.002,50
04/05 D 733 TRANSFERENCIA 36170607 47.287,50 66.290,00
05/05 LEY NRO 25.413 SOBRE CREDIT -397,73 65.892,27
05/05 D 733 TRANSFERENCIA 17713090 45.727,50 111.619,77
05/05 D 733 TRANSFERENCIA 36949679 14.137,50 125.757,27
05/05 D 733 TRANSFERENCIA 30912250 14.137,50 139.894,77
05/05 D 733 TRANSFERENCIA 29394480 150.540,00 290.434,77
Sobre (468902) 1 de 1 / Pagina 2 de 3
3-91300005-03
otpircsnI
FECHA ORIGEN CONCEPTO DEBITO CREDITO SALDO
06/05 D CUPONES PRISMA 70907-0001870260 215.077,19 505.511,96
06/05 D CUPONES PRISMA 70906-0001870260 72.447,57 577.959,53
06/05 LEY NRO 25.413 SOBRE CREDIT -3.072,38 574.887,15
06/05 D 733 TRANSFERENCIA 94700438 84.142,50 659.029,65
07/05 D CUPONES PRISMA 65679-0001870260 356.054,40 1.015.084,05
07/05 D CUPONES PRISMA 65680-0001870260 348.951,75 1.364.035,80
07/05 D CUPONES PRISMA 65681-0001870310 119.700,70 1.483.736,50
07/05 LEY NRO 25.413 SOBRE CREDIT -5.453,08 1.478.283,42
07/05 D 733 TRANSFERENCIA 37806925 975,00 1.479.258,42
07/05 D 733 TRANSFERENCIA 37806925 975,00 1.480.233,42
07/05 D 733 TRANSFERENCIA 43817527 58.012,50 1.538.245,92
07/05 D 733 TRANSFERENCIA 42727219 19.890,00 1.558.135,92
07/05 D 733 TRANSFERENCIA 805007176420017 -1.000,00 1.557.135,92
07/05 D 733 TRANSFERENCIA 805007176420017 -1.000,00 1.556.135,92
08/05 D CUPONES PRISMA 73363-0001870260 199.302,09 1.755.438,01
08/05 D CUPONES PRISMA 73364-0001870310 61.953,58 1.817.391,59
SALDO AL 08 DE MAYO 1.817.391,59`;

describe("parseExtractoBanco — resumen BBVA real (mayo 2026)", () => {
  it("toma saldoInicial de SALDO ANTERIOR y saldoFinal del último saldo corrido", () => {
    const r = parseExtractoBanco(SAMPLE_BBVA_MAYO, 2026);
    expect(r.saldoInicial).toBeCloseTo(0, 2);
    expect(r.saldoFinal).toBeCloseTo(1817391.59, 2);
  });

  it("parsea exactamente las 24 líneas de movimiento (ignora headers/ruido)", () => {
    const r = parseExtractoBanco(SAMPLE_BBVA_MAYO, 2026);
    expect(r.lineas).toHaveLength(24);
  });

  it("cada línea respeta el contrato del cashflow (fecha ISO, comision/retencion 0)", () => {
    const r = parseExtractoBanco(SAMPLE_BBVA_MAYO, 2026);
    for (const l of r.lineas) {
      expect(l.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(l.comision).toBe(0);
      expect(l.retencion).toBe(0);
      expect(typeof l.monto_bruto).toBe("number");
    }
  });

  it("usa el año pasado por parámetro y DD/MM del extracto", () => {
    const r = parseExtractoBanco(SAMPLE_BBVA_MAYO, 2026);
    expect(r.lineas[0]!.fecha).toBe("2026-05-04");
    expect(r.lineas[r.lineas.length - 1]!.fecha).toBe("2026-05-08");
  });

  it("deriva el signo del movimiento del delta de saldo (créditos + / débitos −)", () => {
    const r = parseExtractoBanco(SAMPLE_BBVA_MAYO, 2026);
    // Primer crédito: transferencia entrante de 3.500.
    expect(r.lineas[0]!.monto_bruto).toBeCloseTo(3500, 2);
    expect(r.lineas[0]!.descripcion).toContain("TRANSFERENCIA 26916987");
    // Débito de impuesto LEY 25.413 → negativo.
    const ley = r.lineas.find(l => l.descripcion.includes("LEY NRO 25.413"))!;
    expect(ley.monto_bruto).toBeCloseTo(-397.73, 2);
    // Transferencia saliente (débito) de -1.000.
    const debitoTransfer = r.lineas.filter(l => l.descripcion.includes("805007176420017"));
    expect(debitoTransfer).toHaveLength(2);
    expect(debitoTransfer[0]!.monto_bruto).toBeCloseTo(-1000, 2);
  });

  it("la suma de los montos = saldoFinal − saldoInicial (invariante telescópica)", () => {
    const r = parseExtractoBanco(SAMPLE_BBVA_MAYO, 2026);
    const suma = r.lineas.reduce((s, l) => s + l.monto_bruto, 0);
    expect(suma).toBeCloseTo(r.saldoFinal - r.saldoInicial, 2);
  });

  it("no genera advertencias cuando el saldo declarado cuadra con el derivado", () => {
    const r = parseExtractoBanco(SAMPLE_BBVA_MAYO, 2026);
    expect(r.advertencias ?? []).toHaveLength(0);
  });
});

describe("parseExtractoBanco — robustez", () => {
  it("advierte (no rompe) si el SALDO AL declarado no cuadra con el derivado", () => {
    const trucho = SAMPLE_BBVA_MAYO.replace(
      "SALDO AL 08 DE MAYO 1.817.391,59",
      "SALDO AL 08 DE MAYO 9.999.999,99",
    );
    const r = parseExtractoBanco(trucho, 2026);
    // El saldo final manda el saldo corrido real, no el declarado trucho.
    expect(r.saldoFinal).toBeCloseTo(1817391.59, 2);
    expect((r.advertencias ?? []).length).toBeGreaterThan(0);
  });

  it("devuelve cero líneas y saldos 0 si no hay movimientos", () => {
    const r = parseExtractoBanco("texto sin estructura\nFECHA ORIGEN CONCEPTO\n", 2026);
    expect(r.lineas).toHaveLength(0);
    expect(r.saldoInicial).toBe(0);
    expect(r.saldoFinal).toBe(0);
  });
});

/**
 * Fixture REAL: bloque del resumen Galicia "Caja de Ahorro en Pesos" de Neko
 * Villa Crespo (cuenta a nombre de Lucas Ferrari), junio 2026, extraído del PDF
 * con la capa de texto. Incluye el ruido real (header de columnas repetido,
 * líneas de detalle sin fecha: origen, CUIT, CBU) para verificar que se ignoran.
 * El saldo corre de 2.162.579,40 (derivado) a 1.703.491,16.
 */
const SAMPLE_GALICIA_JUNIO = `Movimientos
Fecha Descripción Origen Crédito Débito Saldo
01/06/26 REINTEGRO PROMOCION GALICIA 2.750,00 2.165.329,40
Starbucks Coffee
01/06/26 TRANSFERENCIAS CASH 1.030.663,58 3.195.992,98
PROVEEDORES
DELIVERY HERO FI
30715221159
BANCO SANTANDER RIO
01/06/26 ING. BRUTOS S/ CRED -20.613,27 3.175.379,71
REG.RECAU.SIRCREB
01/06/26 PAGO CON TRANSFERENCIA -9.500,00 3.165.879,71
BANCO DE GAL
01/06/26 PAGO TARJETA VISA -162.691,20 3.003.188,51
D.A. AL VTO
01/06/26 PAGO TARJETA VISA -1.299.697,35 1.703.491,16
D.A. AL VTO
01/06/26 RESCATE FIMA 3.000.000,00 4.703.491,16
Fima Premium Clase A
01/06/26 TRANSF. CTAS PROPIAS -3.000.000,00 1.703.491,16
CU 20399087539
Resumen de Caja de Ahorro en Pesos Página 1 / 8
CBU 29/05/2026 26/06/2026 $1.703.491,16`;

describe("parseExtractoBancoGalicia — resumen Galicia real (junio 2026)", () => {
  it("deriva saldoInicial del primer movimiento y saldoFinal del último saldo corrido", () => {
    const r = parseExtractoBancoGalicia(SAMPLE_GALICIA_JUNIO, 2026);
    expect(r.saldoInicial).toBeCloseTo(2162579.40, 2);
    expect(r.saldoFinal).toBeCloseTo(1703491.16, 2);
  });

  it("parsea las 8 líneas de movimiento (ignora header, footer y detalle sin fecha)", () => {
    const r = parseExtractoBancoGalicia(SAMPLE_GALICIA_JUNIO, 2026);
    expect(r.lineas).toHaveLength(8);
  });

  it("cada línea respeta el contrato del cashflow (fecha ISO, comision/retencion 0)", () => {
    const r = parseExtractoBancoGalicia(SAMPLE_GALICIA_JUNIO, 2026);
    for (const l of r.lineas) {
      expect(l.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(l.comision).toBe(0);
      expect(l.retencion).toBe(0);
      expect(typeof l.monto_bruto).toBe("number");
    }
  });

  it("usa el año del DD/MM/YY de la línea (26 → 2026)", () => {
    const r = parseExtractoBancoGalicia(SAMPLE_GALICIA_JUNIO, 2026);
    expect(r.lineas[0]!.fecha).toBe("2026-06-01");
  });

  it("deriva el signo del delta de saldo (créditos + / débitos −)", () => {
    const r = parseExtractoBancoGalicia(SAMPLE_GALICIA_JUNIO, 2026);
    // Crédito: reintegro de promoción → +2.750.
    expect(r.lineas[0]!.monto_bruto).toBeCloseTo(2750, 2);
    expect(r.lineas[0]!.descripcion).toContain("REINTEGRO PROMOCION GALICIA");
    // Débito: impuesto ING. BRUTOS → negativo.
    const ib = r.lineas.find(l => l.descripcion.includes("ING. BRUTOS"))!;
    expect(ib.monto_bruto).toBeCloseTo(-20613.27, 2);
    // Débito grande: PAGO TARJETA VISA → negativo.
    const visa = r.lineas.filter(l => l.descripcion.includes("PAGO TARJETA VISA"));
    expect(visa).toHaveLength(2);
    expect(visa[1]!.monto_bruto).toBeCloseTo(-1299697.35, 2);
  });

  it("la suma de los montos = saldoFinal − saldoInicial (invariante telescópica)", () => {
    const r = parseExtractoBancoGalicia(SAMPLE_GALICIA_JUNIO, 2026);
    const suma = r.lineas.reduce((s, l) => s + l.monto_bruto, 0);
    expect(suma).toBeCloseTo(r.saldoFinal - r.saldoInicial, 2);
  });

  it("no genera advertencias cuando el saldo declarado cuadra con el derivado", () => {
    const r = parseExtractoBancoGalicia(SAMPLE_GALICIA_JUNIO, 2026);
    expect(r.advertencias ?? []).toHaveLength(0);
  });
});

describe("parseExtractoBancoGalicia — robustez", () => {
  it("advierte (no rompe) si el saldo de cierre declarado no cuadra", () => {
    const trucho = SAMPLE_GALICIA_JUNIO.replace("$1.703.491,16", "$9.999.999,99");
    const r = parseExtractoBancoGalicia(trucho, 2026);
    expect(r.saldoFinal).toBeCloseTo(1703491.16, 2);
    expect((r.advertencias ?? []).length).toBeGreaterThan(0);
  });

  it("devuelve cero líneas y saldos 0 si no hay movimientos", () => {
    const r = parseExtractoBancoGalicia("Resumen de Caja de Ahorro\nFecha Descripción Saldo\n", 2026);
    expect(r.lineas).toHaveLength(0);
    expect(r.saldoInicial).toBe(0);
    expect(r.saldoFinal).toBe(0);
  });
});
