import { describe, it, expect } from "vitest";
import { parseExtractoMP } from "./mpExtractoParser";

const BOM = String.fromCharCode(0xfeff);

const SAMPLE_REAL = `INITIAL_BALANCE;CREDITS;DEBITS;FINAL_BALANCE
911.181,47;49.231.984,02;-49.482.366,57;660.798,92

RELEASE_DATE;TRANSACTION_TYPE;REFERENCE_ID;TRANSACTION_NET_AMOUNT;PARTIAL_BALANCE
01-04-2026;Rendimientos ;1741796581152;98,76;911.280,23
01-04-2026;Pago de servicio Metrogas;152828257946;-78.436,86;832.843,37
02-04-2026;Transferencia recibida LUCAS TOMAS FERRARI;152979169202;1.000.000,00;1.142.026,77
03-04-2026;Liquidación de dinero ;152345362783;50.839,12;2.626.140,79
03-04-2026;Liquidación de dinero cancelada Venta cancelada;150461420931;-20.657,28;2.575.301,67
30-04-2026;Transferencia recibida Lucia Tamburi;156442052753;12.000,00;660.798,92
`;

describe("parseExtractoMP — formato real account_statement MP", () => {
  it("parsea el header de resumen (balance inicial/créditos/débitos/final)", () => {
    const r = parseExtractoMP(SAMPLE_REAL);
    expect(r).not.toBeNull();
    expect(r!.resumen).toBeDefined();
    expect(r!.resumen!.initial_balance).toBeCloseTo(911181.47, 2);
    expect(r!.resumen!.credits).toBeCloseTo(49231984.02, 2);
    expect(r!.resumen!.debits).toBeCloseTo(-49482366.57, 2);
    expect(r!.resumen!.final_balance).toBeCloseTo(660798.92, 2);
  });

  it("parsea cada movimiento con fecha YYYY-MM-DD + monto signed", () => {
    const r = parseExtractoMP(SAMPLE_REAL)!;
    expect(r.movimientos).toHaveLength(6);

    const rendimientos = r.movimientos[0]!;
    expect(rendimientos.fecha).toBe("2026-04-01");
    expect(rendimientos.monto).toBeCloseTo(98.76, 2);
    expect(rendimientos.descripcion).toBe("Rendimientos");
    expect(rendimientos.tipo).toBe("rendimiento");
    expect(rendimientos.referencia_externa).toBe("1741796581152");

    const metrogas = r.movimientos[1]!;
    expect(metrogas.fecha).toBe("2026-04-01");
    expect(metrogas.monto).toBeCloseTo(-78436.86, 2);
    expect(metrogas.tipo).toBe("pago_servicio");
    expect(metrogas.descripcion).toContain("Metrogas");
  });

  it("categoriza tipos correctamente", () => {
    const r = parseExtractoMP(SAMPLE_REAL)!;
    const porTipo = new Map<string, number>();
    for (const m of r.movimientos) porTipo.set(m.tipo, (porTipo.get(m.tipo) || 0) + 1);
    expect(porTipo.get("rendimiento")).toBe(1);
    expect(porTipo.get("pago_servicio")).toBe(1);
    expect(porTipo.get("transferencia_ingreso")).toBe(2);
    expect(porTipo.get("liquidacion")).toBe(1);
    expect(porTipo.get("liquidacion_cancelada")).toBe(1);
  });

  it("rango_fechas: desde = primer mov, hasta = último", () => {
    const r = parseExtractoMP(SAMPLE_REAL)!;
    expect(r.rango_fechas.desde).toBe("2026-04-01");
    expect(r.rango_fechas.hasta).toBe("2026-04-30");
  });

  it("confianza_global = 1.0 (no hay IA involucrada)", () => {
    const r = parseExtractoMP(SAMPLE_REAL)!;
    expect(r.confianza_global).toBe(1.0);
  });
});

describe("parseExtractoMP — robustez", () => {
  it("acepta BOM UTF-8 al inicio", () => {
    const r = parseExtractoMP(BOM + SAMPLE_REAL)!;
    expect(r).not.toBeNull();
    expect(r.movimientos.length).toBeGreaterThan(0);
  });

  it("acepta CRLF (line endings de Windows)", () => {
    const crlf = SAMPLE_REAL.replace(/\n/g, "\r\n");
    const r = parseExtractoMP(crlf)!;
    expect(r).not.toBeNull();
    expect(r.movimientos.length).toBe(6);
  });

  it("filas con cero columnas o vacías se skipean", () => {
    const conVacias = SAMPLE_REAL.replace("01-04-2026;Rendimientos", "\n\n01-04-2026;Rendimientos");
    const r = parseExtractoMP(conVacias)!;
    expect(r.movimientos.length).toBe(6);
  });

  it("fila con fecha inválida se skipea + agrega advertencia", () => {
    const malo = SAMPLE_REAL.replace("01-04-2026;Rendimientos", "FECHA-MALA;Rendimientos");
    const r = parseExtractoMP(malo)!;
    expect(r.movimientos.length).toBe(5); // 6-1
    expect(r.advertencias.some(a => a.includes("fecha inválida"))).toBe(true);
  });

  it("fila con monto cero o no parseable se skipea", () => {
    const malo = SAMPLE_REAL.replace(";98,76;", ";;");
    const r = parseExtractoMP(malo)!;
    expect(r.movimientos.length).toBe(5); // 6-1
  });

  it("devuelve null si no hay header de movimientos", () => {
    const sinHeader = "Random texto sin estructura\nOtra fila\n";
    expect(parseExtractoMP(sinHeader)).toBeNull();
  });

  it("devuelve null si no hay movimientos válidos", () => {
    const soloHeader = `RELEASE_DATE;TRANSACTION_TYPE;REFERENCE_ID;TRANSACTION_NET_AMOUNT;PARTIAL_BALANCE\n`;
    expect(parseExtractoMP(soloHeader)).toBeNull();
  });

  it("formato AR con miles + coma decimal se parsea correcto", () => {
    const r = parseExtractoMP(SAMPLE_REAL)!;
    const transfer = r.movimientos.find(m => m.descripcion.includes("LUCAS TOMAS"))!;
    expect(transfer.monto).toBeCloseTo(1000000.00, 2);
  });

  it("egresos vienen con monto negativo (signo en CSV)", () => {
    const r = parseExtractoMP(SAMPLE_REAL)!;
    const egresos = r.movimientos.filter(m => m.monto < 0);
    expect(egresos.length).toBe(2); // Metrogas + Liquidación cancelada
  });
});

describe("parseExtractoMP — sanity check vs header de resumen", () => {
  it("genera advertencia si la suma de movs difiere mucho del CREDITS/DEBITS del header", () => {
    // Sample chico: el header dice 49M credits + -49M debits pero nuestros movs
    // suman mucho menos → genera advertencias.
    const r = parseExtractoMP(SAMPLE_REAL)!;
    expect(r.advertencias.some(a => a.toLowerCase().includes("créditos") || a.toLowerCase().includes("débitos"))).toBe(true);
  });
});
