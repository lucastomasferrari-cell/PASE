import { describe, it, expect } from "vitest";
import { parseMonto, estadoFactura, toISO } from "./utils";

describe("parseMonto", () => {
  // Casos de la docstring de la función
  it("formato US puro: '40642.56' → 40642.56", () => {
    expect(parseMonto("40642.56")).toBe(40642.56);
  });

  it("formato AR puro: '40642,56' → 40642.56", () => {
    expect(parseMonto("40642,56")).toBe(40642.56);
  });

  it("formato AR con miles: '1.234,56' → 1234.56", () => {
    expect(parseMonto("1.234,56")).toBe(1234.56);
  });

  it("formato US con miles: '1,234.56' → 1234.56", () => {
    expect(parseMonto("1,234.56")).toBe(1234.56);
  });

  it("passthrough de números nativos", () => {
    expect(parseMonto(40642.56)).toBe(40642.56);
    expect(parseMonto(0)).toBe(0);
    expect(parseMonto(-123.45)).toBe(-123.45);
  });

  it("null/undefined/'' → 0", () => {
    expect(parseMonto(null)).toBe(0);
    expect(parseMonto(undefined)).toBe(0);
    expect(parseMonto("")).toBe(0);
  });

  it("NaN explícito → 0", () => {
    expect(parseMonto(NaN)).toBe(0);
  });

  it("Infinity → 0 (no es finite)", () => {
    expect(parseMonto(Infinity)).toBe(0);
    expect(parseMonto(-Infinity)).toBe(0);
  });

  it("strings no-numéricos → 0", () => {
    expect(parseMonto("foo")).toBe(0);
    expect(parseMonto("abc123")).toBe(0);
  });

  it("trim de espacios", () => {
    expect(parseMonto("  1234,56  ")).toBe(1234.56);
  });

  it("solo espacios → 0", () => {
    expect(parseMonto("   ")).toBe(0);
  });

  it("AR sin decimales: '1.234' (formato típico Excel-AR) → 1234", () => {
    // Único punto, sin coma → se trata como decimal US ("1.234" = 1.234)
    // Esta es una limitación documentada: no podemos saber si el punto es
    // miles o decimales sin contexto. parseMonto opta por decimal.
    expect(parseMonto("1.234")).toBe(1.234);
  });

  it("AR con miles múltiples: '1.234.567,89' → 1234567.89", () => {
    expect(parseMonto("1.234.567,89")).toBe(1234567.89);
  });

  it("US con miles múltiples: '1,234,567.89' → 1234567.89", () => {
    expect(parseMonto("1,234,567.89")).toBe(1234567.89);
  });

  it("entero string sin separadores: '123' → 123", () => {
    expect(parseMonto("123")).toBe(123);
  });

  it("negativo AR: '-1.234,56' → -1234.56", () => {
    expect(parseMonto("-1.234,56")).toBe(-1234.56);
  });
});

describe("estadoFactura", () => {
  const HOY = "2026-05-17";

  it("estado pagada se devuelve tal cual (no derivamos vencida)", () => {
    expect(estadoFactura({ estado: "pagada", venc: "2026-01-01" }, HOY)).toBe("pagada");
  });

  it("estado anulada se devuelve tal cual", () => {
    expect(estadoFactura({ estado: "anulada", venc: "2026-01-01" }, HOY)).toBe("anulada");
  });

  it("pendiente con venc futuro queda pendiente", () => {
    expect(estadoFactura({ estado: "pendiente", venc: "2026-12-31" }, HOY)).toBe("pendiente");
  });

  it("pendiente con venc HOY queda pendiente (no es < hoy)", () => {
    expect(estadoFactura({ estado: "pendiente", venc: HOY }, HOY)).toBe("pendiente");
  });

  it("pendiente con venc pasado → vencida (derivado al vuelo)", () => {
    expect(estadoFactura({ estado: "pendiente", venc: "2026-05-01" }, HOY)).toBe("vencida");
  });

  it("pendiente sin venc queda pendiente (no podemos derivar)", () => {
    expect(estadoFactura({ estado: "pendiente", venc: null }, HOY)).toBe("pendiente");
    expect(estadoFactura({ estado: "pendiente" }, HOY)).toBe("pendiente");
  });

  it("estado ya vencida se devuelve tal cual aunque venc sea futuro", () => {
    // El estado guardado en DB siempre gana si no es "pendiente"
    expect(estadoFactura({ estado: "vencida", venc: "2099-01-01" }, HOY)).toBe("vencida");
  });
});

describe("toISO", () => {
  it("convierte Date a YYYY-MM-DD", () => {
    // Date(year, month-1, day) crea fecha LOCAL — para test determinístico
    // usamos UTC explicito.
    const d = new Date("2026-05-17T15:30:00.000Z");
    expect(toISO(d)).toBe("2026-05-17");
  });

  it("date a mitad de noche UTC mantiene día correcto", () => {
    const d = new Date("2026-12-31T23:59:59.000Z");
    expect(toISO(d)).toBe("2026-12-31");
  });
});
