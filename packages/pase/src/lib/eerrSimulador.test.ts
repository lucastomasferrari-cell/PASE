import { describe, it, expect } from "vitest";
import { simularEERR, aplicarAjuste, type LineasEERR } from "./eerrSimulador";

const BASE: LineasEERR = {
  ventas: 1_000_000, cmv: 350_000,
  gastosFijos: 100_000, gastosVar: 50_000, sueldos: 200_000,
  cargasSociales: 60_000, publicidad: 20_000, comisiones: 30_000,
  impuestos: 40_000, otrosGastos: 10_000,
};
// gastos op = 510_000 ; utilBruta = 650_000 ; utilNeta = 140_000 ; margen 14%

describe("aplicarAjuste", () => {
  it("sin ajuste devuelve la base", () => expect(aplicarAjuste(100, undefined)).toBe(100));
  it("abs reemplaza el valor", () => expect(aplicarAjuste(100, { tipo: "abs", valor: 250 })).toBe(250));
  it("pct ajusta relativo (-10% => 90)", () => expect(aplicarAjuste(100, { tipo: "pct", valor: -10 })).toBe(90));
});

describe("simularEERR", () => {
  it("sin ajustes reproduce el EERR base", () => {
    const r = simularEERR(BASE, {});
    expect(r.utilBruta).toBe(650_000);
    expect(r.utilNeta).toBe(140_000);
    expect(r.margenNeto).toBeCloseTo(0.14, 5);
  });

  it("ajuste abs en CMV recalcula utilidades", () => {
    const r = simularEERR(BASE, { cmv: { tipo: "abs", valor: 300_000 } });
    expect(r.utilBruta).toBe(700_000);
    expect(r.utilNeta).toBe(190_000);
  });

  it("subir ventas sin tocar CMV: sube utilidad y margen, baja el CMV%", () => {
    const r = simularEERR(BASE, { ventas: { tipo: "pct", valor: 20 } });
    expect(r.lineas.ventas).toBe(1_200_000);
    expect(r.lineas.cmv).toBe(350_000); // CMV en $ NO cambió
    expect(r.utilNeta).toBeGreaterThan(140_000);
    expect(r.margenNeto).toBeGreaterThan(0.14);
    expect(r.lineas.cmv / r.lineas.ventas).toBeLessThan(BASE.cmv / BASE.ventas);
  });

  it("ventas en 0 → margen 0 (sin división por cero)", () => {
    const r = simularEERR({ ...BASE, ventas: 0 }, {});
    expect(r.margenNeto).toBe(0);
  });

  it("no muta el objeto base", () => {
    const snap = JSON.parse(JSON.stringify(BASE));
    simularEERR(BASE, { ventas: { tipo: "pct", valor: 50 } });
    expect(BASE).toEqual(snap);
  });
});
