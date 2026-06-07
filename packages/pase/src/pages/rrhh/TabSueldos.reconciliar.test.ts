import { describe, it, expect } from "vitest";
import { reconciliarNovEdits } from "./TabSueldos";

// Fila mínima de novedadesDB con los campos que lee novDBaEdit + el matching.
function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: "x", empleado_id: "E1", mes: 5, anio: 2026, cuota_num: 1, cuotas_total: 1,
    inasistencias: 0, presentismo: "MANTIENE", horas_extras: 0, dobles: 0, feriados: 0,
    vacaciones_dias: 0, otros_descuentos: 0, otros_descuentos_motivo: null,
    observaciones: null, estado: "confirmado", monto_efectivo: null, monto_mp: null,
    ...over,
  };
}
const slot = { key: "E1__1", empId: "E1", cuota: 1, cuotasTotal: 1 };
const NOV0 = { inasistencias: 0, horas_extras: 0, dobles: 0, feriados: 0, vacaciones_dias: 0, presentismo_mantiene: true, otros_desc: 0, bono: 0, obs: "" };

describe("reconciliarNovEdits (fix data-loss sueldos 04-jun)", () => {
  it("slot NO tocado con prev en 0 pero la DB tiene datos → re-sincroniza desde la DB", () => {
    // Este es EXACTAMENTE el bug: el init quedó en 0 (NOV_VACIA) y antes no
    // re-sincronizaba → los inputs quedaban en 0 y se persistían 0s encima.
    const prev = { "E1__1": { ...NOV0 } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const next = reconciliarNovEdits(prev, [dbRow({ horas_extras: 8 })] as any, [slot], new Set());
    expect(next["E1__1"]!.horas_extras).toBe(8);
  });

  it("slot TOCADO por el user → preserva su edición (no pisa con la DB)", () => {
    const prev = { "E1__1": { ...NOV0, horas_extras: 99 } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const next = reconciliarNovEdits(prev, [dbRow({ horas_extras: 8 })] as any, [slot], new Set(["E1__1"]));
    expect(next["E1__1"]!.horas_extras).toBe(99);
  });

  it("sin fila en la DB → NOV_VACIA (0s)", () => {
    const next = reconciliarNovEdits({}, [], [slot], new Set());
    expect(next["E1__1"]!.horas_extras).toBe(0);
    expect(next["E1__1"]!.inasistencias).toBe(0);
  });

  it("re-sincroniza todos los campos (inas, feriados, otros, presentismo)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const next = reconciliarNovEdits({}, [dbRow({ inasistencias: 7, feriados: 2, otros_descuentos: 65000, presentismo: "PIERDE" })] as any, [slot], new Set());
    expect(next["E1__1"]!.inasistencias).toBe(7);
    expect(next["E1__1"]!.feriados).toBe(2);
    expect(next["E1__1"]!.otros_desc).toBe(65000);
    expect(next["E1__1"]!.presentismo_mantiene).toBe(false);
  });
});
