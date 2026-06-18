import { describe, it, expect } from "vitest";
import { buildSueldoBreakdown } from "./eerrDetalle";
import type { LiquidacionConEmpleado } from "../types/rrhh";

// Liquidación mínima — solo los campos que usa buildSueldoBreakdown.
const liq = (over: Partial<LiquidacionConEmpleado>): LiquidacionConEmpleado => ({
  sueldo_base: 0, monto_presentismo: 0, total_horas_extras: 0, total_dobles: 0,
  total_feriados: 0, total_vacaciones: 0, descuento_ausencias: 0, adelantos: 0,
  total_a_pagar: 0, pagos_realizados: 0,
  ...over,
} as unknown as LiquidacionConEmpleado);

describe("buildSueldoBreakdown", () => {
  it("omite las líneas en cero pero siempre incluye el saldo en liquidación", () => {
    const rows = buildSueldoBreakdown([liq({ sueldo_base: 100000, total_a_pagar: 100000 })]);
    const labels = rows.map(r => r.label);
    expect(labels).toEqual(["Sueldo base", "Saldo en liquidación"]);
    expect(rows.find(r => r.label === "Saldo en liquidación")?.big).toBe(true);
  });

  it("suma varias liquidaciones del mismo empleado (quincenas/cuotas)", () => {
    const rows = buildSueldoBreakdown([
      liq({ sueldo_base: 100000, total_a_pagar: 100000 }),
      liq({ sueldo_base: 50000, total_horas_extras: 20000, total_a_pagar: 70000 }),
    ]);
    expect(rows.find(r => r.label === "Sueldo base")?.monto).toBe(150000);
    expect(rows.find(r => r.label === "Horas extras")?.monto).toBe(20000);
    expect(rows.find(r => r.label === "Saldo en liquidación")?.monto).toBe(170000);
  });

  it("marca los descuentos como negativos", () => {
    const rows = buildSueldoBreakdown([
      liq({ sueldo_base: 100000, descuento_ausencias: 8000, adelantos: 15000, total_a_pagar: 77000 }),
    ]);
    expect(rows.find(r => r.label === "Ausencias")?.neg).toBe(true);
    expect(rows.find(r => r.label === "Adelantos (descontados)")?.neg).toBe(true);
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

  it("atribuye el adelanto pagado por fuera y reconcilia el total del mes (caso ROJAS)", () => {
    const rows = buildSueldoBreakdown(
      [liq({ sueldo_base: 900000, adelantos: 150000, total_a_pagar: 750000, pagos_realizados: 750000 })],
      [{ fecha: "2026-05-19", monto: 150000, label: "Adelanto" }],
    );
    // saldo de la liquidación = 750k
    expect(rows.find(r => r.label === "Saldo en liquidación")?.monto).toBe(750000);
    // el adelanto aparece adentro del empleado, con su fecha
    expect(rows.find(r => r.label === "Adelanto ya pagado (19/05)")?.monto).toBe(150000);
    // total del mes = liquidación + adelanto = sueldo base
    const totalMes = rows.find(r => r.label === "Total del mes");
    expect(totalMes?.monto).toBe(900000);
    expect(totalMes?.big).toBe(true);
  });

  it("sin adelantos no agrega la línea 'Total del mes'", () => {
    const rows = buildSueldoBreakdown([liq({ sueldo_base: 100000, total_a_pagar: 100000 })]);
    expect(rows.find(r => r.label === "Total del mes")).toBeUndefined();
  });
});
