import { describe, it, expect } from "vitest";
import { buildSueldoBreakdown } from "./EERRDetalleModal";
import type { LiquidacionConEmpleado } from "../types/rrhh";

// Liquidación mínima — solo los campos que usa buildSueldoBreakdown.
const liq = (over: Partial<LiquidacionConEmpleado>): LiquidacionConEmpleado => ({
  sueldo_base: 0, monto_presentismo: 0, total_horas_extras: 0, total_dobles: 0,
  total_feriados: 0, total_vacaciones: 0, descuento_ausencias: 0, adelantos: 0,
  total_a_pagar: 0, pagos_realizados: 0,
  ...over,
} as unknown as LiquidacionConEmpleado);

describe("buildSueldoBreakdown", () => {
  it("omite las líneas en cero pero siempre incluye Total a pagar", () => {
    const rows = buildSueldoBreakdown([liq({ sueldo_base: 100000, total_a_pagar: 100000 })]);
    const labels = rows.map(r => r.label);
    expect(labels).toEqual(["Sueldo base", "Total a pagar"]);
    expect(rows.find(r => r.label === "Total a pagar")?.big).toBe(true);
  });

  it("suma varias liquidaciones del mismo empleado (quincenas/cuotas)", () => {
    const rows = buildSueldoBreakdown([
      liq({ sueldo_base: 100000, total_a_pagar: 100000 }),
      liq({ sueldo_base: 50000, total_horas_extras: 20000, total_a_pagar: 70000 }),
    ]);
    expect(rows.find(r => r.label === "Sueldo base")?.monto).toBe(150000);
    expect(rows.find(r => r.label === "Horas extras")?.monto).toBe(20000);
    expect(rows.find(r => r.label === "Total a pagar")?.monto).toBe(170000);
  });

  it("marca los descuentos como negativos", () => {
    const rows = buildSueldoBreakdown([
      liq({ sueldo_base: 100000, descuento_ausencias: 8000, adelantos: 15000, total_a_pagar: 77000 }),
    ]);
    expect(rows.find(r => r.label === "Ausencias")?.neg).toBe(true);
    expect(rows.find(r => r.label === "Adelantos")?.neg).toBe(true);
    expect(rows.find(r => r.label === "Sueldo base")?.neg).toBeUndefined();
  });

  it("incluye bono y otros_descuentos (campos fuera del tipo base)", () => {
    const rows = buildSueldoBreakdown([
      liq({ sueldo_base: 100000, total_a_pagar: 130000, bono: 40000, otros_descuentos: 10000 } as Partial<LiquidacionConEmpleado>),
    ]);
    expect(rows.find(r => r.label === "Bono")?.monto).toBe(40000);
    expect(rows.find(r => r.label === "Otros descuentos")?.monto).toBe(10000);
    expect(rows.find(r => r.label === "Otros descuentos")?.neg).toBe(true);
  });
});
