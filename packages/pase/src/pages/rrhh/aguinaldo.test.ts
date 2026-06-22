import { describe, it, expect } from "vitest";
import { calcularAguinaldo } from "./aguinaldo";

// Fecha de pago: 22/06/2026 → semestre ene-jun 2026 (181 días).
const PAGO = new Date(2026, 5, 22); // mes 5 = junio (local)

describe("calcularAguinaldo", () => {
  it("trabajó todo el semestre → medio sueldo completo (no parcial)", () => {
    const r = calcularAguinaldo(1_000_000, "2026-01-01", PAGO);
    expect(r.monto).toBe(500_000);
    expect(r.parcial).toBe(false);
    expect(r.diasTrabajados).toBe(181);
    expect(r.diasSemestre).toBe(181);
  });

  it("ingresó antes del semestre → medio sueldo completo", () => {
    const r = calcularAguinaldo(800_000, "2025-03-10", PAGO);
    expect(r.monto).toBe(400_000);
    expect(r.parcial).toBe(false);
  });

  it("fecha_inicio null → se asume semestre completo (no underpaga)", () => {
    const r = calcularAguinaldo(1_000_000, null, PAGO);
    expect(r.monto).toBe(500_000);
    expect(r.parcial).toBe(false);
  });

  it("caso ALESSANDRO: ingresó 13/4 → proporcional ~79/181", () => {
    const r = calcularAguinaldo(1_000_000, "2026-04-13", PAGO);
    expect(r.diasTrabajados).toBe(79); // 13/4..30/6 inclusive
    expect(r.parcial).toBe(true);
    // 500.000 * 79/181 = 218.232,04 → 218232
    expect(r.monto).toBe(218_232);
  });

  it("ingresó justo el último día del semestre → 1 día", () => {
    const r = calcularAguinaldo(600_000, "2026-06-30", PAGO);
    expect(r.diasTrabajados).toBe(1);
    expect(r.monto).toBe(Math.round((600_000 / 2) * (1 / 181)));
    expect(r.parcial).toBe(true);
  });

  it("ingresó después del fin del semestre → 0", () => {
    const r = calcularAguinaldo(1_000_000, "2026-07-05", PAGO);
    expect(r.monto).toBe(0);
    expect(r.diasTrabajados).toBe(0);
    expect(r.parcial).toBe(true);
  });

  it("segundo semestre (pago en diciembre) → 184 días jul-dic", () => {
    const r = calcularAguinaldo(1_000_000, "2026-07-01", new Date(2026, 11, 10));
    expect(r.diasSemestre).toBe(184); // 31+31+30+31+30+31
    expect(r.monto).toBe(500_000);
    expect(r.parcial).toBe(false);
  });
});
