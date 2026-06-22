import { describe, it, expect } from "vitest";
import { assembleCierre, type CierreInput } from "./cierreData";

// Rene Cantina mayo 2026 (validado vs CSV de PASE) + abril como mes anterior.
const base: CierreInput = {
  localNombre: "Rene Cantina", mes: "2026-05", emitido: "21/06/2026",
  ventas: 106765435.5, cmv: 39160853.4, utilBruta: 67604582.1,
  gastosFijosVar: 11068053.92, sueldos: 14603400, cargas: 2892195.01, boletas: 692452,
  publicidad: 0, comisiones: 2519349.8, impuestos: 5354107.34, otros: 0, utilNeta: 30475024.03,
  porMedio: [{ label: "EFECTIVO", value: 30000000 }, { label: "MERCADOPAGO", value: 76765435.5 }],
  cmvPorCat: [{ label: "PESCADERIA", value: 20000000 }, { label: "VERDULERIA", value: 19160853.4 }],
  gastosPorCat: [{ label: "ALQUILER", value: 8000000 }, { label: "EXPENSAS", value: 3068053.92 }],
  prev: { ventas: 90000000, cmv: 27000000, gastosFijos: 9000000, gastosVar: 0, publicidad: 0, comisiones: 2000000, impuestos: 4000000, otrosGastos: 0, sueldos: 13000000, cargasSociales: 2500000, utilNeta: 24000000 },
  prevMes: "2026-04",
  socios: [{ nombre: "David", porcentaje: 50 }, { nombre: "Neko", porcentaje: 50 }],
};

describe("assembleCierre", () => {
  it("portada con local y mes", () => {
    const m = assembleCierre(base);
    expect(m.portada.localNombre).toBe("Rene Cantina");
    expect(m.portada.mesLabel).toBe("Mayo 2026");
  });
  it("ingresos: total formateado + comparación con mes anterior", () => {
    const m = assembleCierre(base);
    expect(m.ingresos.totalFmt).toBe("$106.765.435,50");
    expect(m.ingresos.prevLabel).toBe("Abril 2026");
    expect(m.ingresos.prevFmt).toBe("$90.000.000,00");
    expect(m.ingresos.items.length).toBe(2);
    expect(m.ingresos.chart.length).toBeGreaterThan(0);
  });
  it("cmv: % sobre ventas + % mes anterior + utilidad bruta", () => {
    const m = assembleCierre(base);
    expect(m.cmv.pctVentas).toBe("36,7%");
    expect(m.cmv.prevPct).toBe("30,0%"); // 27M / 90M
    expect(m.cmv.utilBrutaPct).toBe("63,3%");
  });
  it("resumen: rentabilidad final y total de gastos", () => {
    const m = assembleCierre(base);
    expect(m.resumen.rentabilidadFmt).toBe("$30.475.024,03");
    expect(m.resumen.rentabilidadPct).toBe("28,5%");
    expect(m.resumen.totalGastosFmt).toBe("$76.290.411,47"); // ventas - utilNeta
  });
  it("división: reparto por socio sobre la rentabilidad", () => {
    const m = assembleCierre(base);
    expect(m.division).not.toBeNull();
    expect(m.division!.items[0]!.nombre).toBe("David");
    expect(m.division!.items[0]!.montoFmt).toMatch(/^\$15\.237\.512/); // utilNeta × 50%
  });
  it("sin socios o utilidad ≤ 0 → división null", () => {
    expect(assembleCierre({ ...base, socios: [] }).division).toBeNull();
    expect(assembleCierre({ ...base, utilNeta: -100 }).division).toBeNull();
  });
  it("sin mes anterior → sin comparación, sin romper", () => {
    const m = assembleCierre({ ...base, prev: null, prevMes: null });
    expect(m.ingresos.prevFmt).toBeNull();
    expect(m.cmv.prevPct).toBeNull();
  });
  it("mes anterior sin cargar (ventas 0) → no compara (sería falso)", () => {
    const prevVacio = { ventas: 0, cmv: 0, gastosFijos: 0, gastosVar: 0, publicidad: 0, comisiones: 0, impuestos: 0, otrosGastos: 0, sueldos: 0, cargasSociales: 0, utilNeta: 0 };
    const m = assembleCierre({ ...base, prev: prevVacio, prevMes: "2026-04" });
    expect(m.ingresos.prevFmt).toBeNull();
    expect(m.ingresos.prevLabel).toBeNull();
    expect(m.cmv.prevPct).toBeNull();
    expect(m.gastos.prevPct).toBeNull();
  });
  it("ventas 0 (apertura) → % '—', sin NaN/Infinity", () => {
    const m = assembleCierre({ ...base, ventas: 0 });
    const s = JSON.stringify(m);
    expect(s).not.toContain("NaN");
    expect(s).not.toContain("Infinity");
    expect(m.cmv.pctVentas).toBe("—");
  });
});
