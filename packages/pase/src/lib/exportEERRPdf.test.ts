import { describe, it, expect } from "vitest";
import { buildEERRReportHtml, type EERRPdfData } from "./exportEERRPdf";

// Datos reales de Rene Cantina mayo 2026 (validados contra el CSV de PASE).
const sample: EERRPdfData = {
  localNombre: "Rene Cantina", mes: "2026-05", emitido: "19/06/2026",
  ventas: 106765435.5, cmv: 39160853.4, utilBruta: 67604582.1,
  gastosFijosVar: 11068053.92, sueldos: 14603400, cargas: 2892195.01, boletas: 692452,
  publicidad: 0, comisiones: 2519349.8, impuestos: 5354107.34, otros: 0, utilNeta: 30475024.03,
};

describe("buildEERRReportHtml", () => {
  const html = buildEERRReportHtml(sample);

  it("incluye el nombre del local y el mes", () => {
    expect(html).toContain("Rene Cantina");
    expect(html).toContain("Mayo 2026");
  });

  it("formatea los montos en pesos AR", () => {
    expect(html).toContain("$106.765.435,50"); // ventas
    expect(html).toContain("−$39.160.853,40"); // CMV como negativo
    expect(html).toContain("$30.475.024,03");  // utilidad neta
  });

  it("calcula el margen neto y el costo primo sobre ventas", () => {
    expect(html).toContain("Margen 28,5%");        // utilNeta / ventas
    expect(html).toContain("53,7% de las ventas"); // costo primo (cmv + laboral)
  });

  it("ordena los gastos de mayor a menor (sueldos primero)", () => {
    const iSueldos = html.indexOf("Sueldos");
    const iBoletas = html.indexOf("Boletas sindicales");
    expect(iSueldos).toBeGreaterThan(0);
    expect(iSueldos).toBeLessThan(iBoletas);
  });

  it("no rompe con ventas en 0 (mes de pre-apertura)", () => {
    const cero = buildEERRReportHtml({ ...sample, ventas: 0, utilNeta: -12305118.57, cmv: 1270451.24, utilBruta: -1270451.24,
      gastosFijosVar: 0, cargas: 0, boletas: 0, comisiones: 0, impuestos: 0, sueldos: 11034667.33 });
    expect(cero).toContain("—");        // porcentajes sobre 0 = "—"
    expect(cero).not.toContain("NaN");
    expect(cero).not.toContain("Infinity");
  });
});
