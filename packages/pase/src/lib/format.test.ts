import { describe, it, expect } from "vitest";
import { formatCurrency, formatCurrencyCompact, formatDelta, fmt_money } from "./format";

const MINUS = "−"; // signo menos Unicode (no es el guion común U+002D)

describe("formatCurrency", () => {
  it("entero positivo → '$1.240.000' (símbolo pegado, miles con punto)", () => {
    expect(formatCurrency(1_240_000)).toBe("$1.240.000");
  });

  it("cero → '$0'", () => {
    expect(formatCurrency(0)).toBe("$0");
  });

  it("entero positivo chico → '$450'", () => {
    expect(formatCurrency(450)).toBe("$450");
  });

  it("decimal positivo → '$1.234,56' (coma decimal, punto miles)", () => {
    expect(formatCurrency(1234.56)).toBe("$1.234,56");
  });

  it("negativo usa signo menos Unicode U+2212 (no guion)", () => {
    expect(formatCurrency(-5400.5)).toBe(`${MINUS}$5.400,5`);
    expect(formatCurrency(-5400.5).startsWith(MINUS)).toBe(true);
  });

  it("negativo entero", () => {
    expect(formatCurrency(-1_000_000)).toBe(`${MINUS}$1.000.000`);
  });

  it("fmt_money es alias de formatCurrency", () => {
    expect(fmt_money(123456)).toBe(formatCurrency(123456));
  });
});

describe("formatCurrencyCompact", () => {
  it("millones con 2 decimales y trim de ceros: 42_100_000 → '$42.1M'", () => {
    expect(formatCurrencyCompact(42_100_000)).toBe("$42.1M");
  });

  it("millones con 2 decimales NO trim cuando hay un dígito significativo: 42_150_000 → '$42.15M'", () => {
    expect(formatCurrencyCompact(42_150_000)).toBe("$42.15M");
  });

  it("millones redondos: 5_000_000 → '$5M' (sin decimales)", () => {
    expect(formatCurrencyCompact(5_000_000)).toBe("$5M");
  });

  it("miles redondea sin decimales: 180_000 → '$180k'", () => {
    expect(formatCurrencyCompact(180_000)).toBe("$180k");
  });

  it("miles con decimales se redondea: 180_700 → '$181k'", () => {
    expect(formatCurrencyCompact(180_700)).toBe("$181k");
  });

  it("menor a 1000 sin sufijo: 450 → '$450'", () => {
    expect(formatCurrencyCompact(450)).toBe("$450");
  });

  it("cero", () => {
    expect(formatCurrencyCompact(0)).toBe("$0");
  });

  it("negativos preservan magnitud + sufijo + signo menos Unicode", () => {
    expect(formatCurrencyCompact(-42_100_000)).toBe(`${MINUS}$42.1M`);
    expect(formatCurrencyCompact(-180_000)).toBe(`${MINUS}$180k`);
    expect(formatCurrencyCompact(-450)).toBe(`${MINUS}$450`);
  });
});

describe("formatDelta", () => {
  it("positivo con 'pts' → '+2,1 pts'", () => {
    expect(formatDelta(2.1, "pts")).toBe("+2,1 pts");
  });

  it("negativo con 'pts' → '−1,4 pts' (signo Unicode pegado)", () => {
    expect(formatDelta(-1.4, "pts")).toBe(`${MINUS}1,4 pts`);
  });

  it("positivo con '%' → '+4,8%'", () => {
    expect(formatDelta(4.8, "%")).toBe("+4,8%");
  });

  it("negativo con '%' → '−4,8%'", () => {
    expect(formatDelta(-4.8, "%")).toBe(`${MINUS}4,8%`);
  });

  it("positivo con '$' → '+$45.000' (formato moneda integer)", () => {
    expect(formatDelta(45000, "$")).toBe("+$45.000");
  });

  it("negativo con '$' → '−$45.000'", () => {
    expect(formatDelta(-45000, "$")).toBe(`${MINUS}$45.000`);
  });

  it("sin unidad → '+0,5' / '−0,5'", () => {
    expect(formatDelta(0.5)).toBe("+0,5");
    expect(formatDelta(-0.5)).toBe(`${MINUS}0,5`);
  });

  it("cero exacto se trata como POSITIVO (+0)", () => {
    // value >= 0 → sign = '+'
    expect(formatDelta(0, "pts")).toBe("+0,0 pts");
    expect(formatDelta(0, "%")).toBe("+0,0%");
  });

  it("delta moneda con decimales se redondea al entero por toLocaleString default", () => {
    // 45.123,49 → "$45.123,49" (formato AR pesos)
    expect(formatDelta(45123.49, "$")).toBe("+$45.123,49");
  });
});
