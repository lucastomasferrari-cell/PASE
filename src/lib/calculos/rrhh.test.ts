import { describe, it, expect } from "vitest";
import {
  diasVacacionesPorAnio,
  calcularVacaciones,
  calcularSACTeorico,
  calcularSACProporcional,
  calcularSueldoBase,
  calcularDescuentoAusencias,
  calcularHorasExtras,
  calcularPresentismo,
  calcularTotalLiquidacion,
  calcularLiquidacionFinal,
} from "./rrhh";

// ─── diasVacacionesPorAnio ───────────────────────────────────────────────────

describe("diasVacacionesPorAnio", () => {
  it("< 5 años → 14 días", () => {
    expect(diasVacacionesPorAnio(0)).toBe(14);
    expect(diasVacacionesPorAnio(1)).toBe(14);
    expect(diasVacacionesPorAnio(4)).toBe(14);
    expect(diasVacacionesPorAnio(4.9)).toBe(14);
  });

  it("5-9 años → 21 días", () => {
    expect(diasVacacionesPorAnio(5)).toBe(21);
    expect(diasVacacionesPorAnio(7)).toBe(21);
    expect(diasVacacionesPorAnio(9.9)).toBe(21);
  });

  it("10-19 años → 28 días", () => {
    expect(diasVacacionesPorAnio(10)).toBe(28);
    expect(diasVacacionesPorAnio(15)).toBe(28);
    expect(diasVacacionesPorAnio(19.9)).toBe(28);
  });

  it(">= 20 años → 35 días", () => {
    expect(diasVacacionesPorAnio(20)).toBe(35);
    expect(diasVacacionesPorAnio(30)).toBe(35);
  });
});

// ─── calcularVacaciones ──────────────────────────────────────────────────────

describe("calcularVacaciones", () => {
  const ref = new Date("2026-04-15T12:00:00");

  it("2 meses de antigüedad → 14/12 * 2 ≈ 2.33 días", () => {
    const result = calcularVacaciones("2026-02-15", 0, ref);
    expect(result).toBeCloseTo((14 / 12) * 2, 2);
  });

  it("1 año de antigüedad → 14 días", () => {
    const result = calcularVacaciones("2025-04-15", 0, ref);
    expect(result).toBeCloseTo(14, 2);
  });

  it("5 años exactos → 21/12 * 60 = 105 días acumulados", () => {
    const result = calcularVacaciones("2021-04-15", 0, ref);
    expect(result).toBeCloseTo((21 / 12) * 60, 2);
  });

  it("10 años → 28/12 * 120 = 280 días acumulados", () => {
    const result = calcularVacaciones("2016-04-15", 0, ref);
    expect(result).toBeCloseTo((28 / 12) * 120, 2);
  });

  it("20 años → 35/12 * 240 = 700 días acumulados", () => {
    const result = calcularVacaciones("2006-04-15", 0, ref);
    expect(result).toBeCloseTo((35 / 12) * 240, 2);
  });

  it("resta días tomados", () => {
    // 1 año = 14 días acumulados, tomó 5
    const result = calcularVacaciones("2025-04-15", 5, ref);
    expect(result).toBeCloseTo(9, 2);
  });

  it("días tomados > acumulados → clampea a 0", () => {
    const result = calcularVacaciones("2026-02-15", 100, ref);
    expect(result).toBe(0);
  });

  it("fecha_inicio futura → 0 días", () => {
    const result = calcularVacaciones("2027-01-01", 0, ref);
    expect(result).toBe(0);
  });

  it("fecha_inicio null → 0", () => {
    expect(calcularVacaciones(null, 0, ref)).toBe(0);
  });

  it("fecha_inicio undefined → 0", () => {
    expect(calcularVacaciones(undefined, 0, ref)).toBe(0);
  });

  it("fecha_inicio inválida → 0", () => {
    expect(calcularVacaciones("basura", 0, ref)).toBe(0);
  });

  it("mismo mes de inicio → 0 (0 meses transcurridos)", () => {
    const result = calcularVacaciones("2026-04-01", 0, ref);
    expect(result).toBe(0);
  });
});

// ─── calcularSACTeorico ─────────────────────────────────────────────────────

describe("calcularSACTeorico", () => {
  it("sueldo 600000 → 300000", () => {
    expect(calcularSACTeorico(600000)).toBe(300000);
  });

  it("sueldo 0 → 0", () => {
    expect(calcularSACTeorico(0)).toBe(0);
  });

  it("sueldo negativo → 0", () => {
    expect(calcularSACTeorico(-100)).toBe(0);
  });

  it("sueldo 1 → 0.5", () => {
    expect(calcularSACTeorico(1)).toBe(0.5);
  });
});

// ─── calcularSACProporcional ─────────────────────────────────────────────────

describe("calcularSACProporcional", () => {
  const sueldo = 600000;

  it("enero (mes 1, S1) → sueldo/12 * 1 = 50000", () => {
    expect(calcularSACProporcional(sueldo, 1)).toBeCloseTo(50000, 0);
  });

  it("abril (mes 4, S1) → sueldo/12 * 4 = 200000", () => {
    expect(calcularSACProporcional(sueldo, 4)).toBeCloseTo(200000, 0);
  });

  it("junio (mes 6, S1) → sueldo/12 * 6 = sueldo/2 = 300000", () => {
    expect(calcularSACProporcional(sueldo, 6)).toBeCloseTo(300000, 0);
  });

  it("julio (mes 7, S2) → sueldo/12 * 1 = 50000", () => {
    expect(calcularSACProporcional(sueldo, 7)).toBeCloseTo(50000, 0);
  });

  it("diciembre (mes 12, S2) → sueldo/12 * 6 = sueldo/2 = 300000", () => {
    expect(calcularSACProporcional(sueldo, 12)).toBeCloseTo(300000, 0);
  });

  it("sueldo 0 → 0", () => {
    expect(calcularSACProporcional(0, 4)).toBe(0);
  });

  it("sueldo negativo → 0", () => {
    expect(calcularSACProporcional(-1000, 4)).toBe(0);
  });

  it("mes inválido 0 → 0", () => {
    expect(calcularSACProporcional(sueldo, 0)).toBe(0);
  });

  it("mes inválido 13 → 0", () => {
    expect(calcularSACProporcional(sueldo, 13)).toBe(0);
  });
});

// ─── calcularSueldoBase ──────────────────────────────────────────────────────

describe("calcularSueldoBase", () => {
  it("MENSUAL → sueldo completo", () => {
    expect(calcularSueldoBase(600000, "MENSUAL")).toBe(600000);
  });

  it("QUINCENAL → sueldo / 2", () => {
    expect(calcularSueldoBase(600000, "QUINCENAL")).toBe(300000);
  });

  it("SEMANAL → sueldo / 4", () => {
    expect(calcularSueldoBase(600000, "SEMANAL")).toBe(150000);
  });
});

// ─── calcularDescuentoAusencias ──────────────────────────────────────────────

describe("calcularDescuentoAusencias", () => {
  const sueldo = 600000;
  const valorDia = sueldo / 30; // 20000

  it("2 inasistencias → 2 × valor_dia", () => {
    expect(calcularDescuentoAusencias(2, sueldo)).toBeCloseTo(valorDia * 2, 0);
  });

  it("0 inasistencias → 0", () => {
    expect(calcularDescuentoAusencias(0, sueldo)).toBe(0);
  });

  it("inasistencias negativas → 0", () => {
    expect(calcularDescuentoAusencias(-1, sueldo)).toBe(0);
  });

  it("sueldo 0 → 0", () => {
    expect(calcularDescuentoAusencias(5, 0)).toBe(0);
  });

  it("30 inasistencias → sueldo completo", () => {
    expect(calcularDescuentoAusencias(30, sueldo)).toBeCloseTo(sueldo, 0);
  });
});

// ─── calcularHorasExtras ─────────────────────────────────────────────────────

describe("calcularHorasExtras", () => {
  const sueldo = 600000;
  const valorHora = sueldo / 30 / 8; // 2500

  it("8 horas extras → 8 × valor_hora", () => {
    expect(calcularHorasExtras(8, sueldo)).toBeCloseTo(valorHora * 8, 0);
  });

  it("0 horas → 0", () => {
    expect(calcularHorasExtras(0, sueldo)).toBe(0);
  });

  it("horas negativas → 0", () => {
    expect(calcularHorasExtras(-5, sueldo)).toBe(0);
  });

  it("sueldo 0 → 0", () => {
    expect(calcularHorasExtras(10, 0)).toBe(0);
  });
});

// ─── calcularPresentismo ─────────────────────────────────────────────────────

describe("calcularPresentismo", () => {
  it("mantiene → 5% del sueldo", () => {
    expect(calcularPresentismo(600000, true)).toBe(30000);
  });

  it("no mantiene → 0", () => {
    expect(calcularPresentismo(600000, false)).toBe(0);
  });

  it("sueldo 0 → 0", () => {
    expect(calcularPresentismo(0, true)).toBe(0);
  });

  it("sueldo negativo → 0", () => {
    expect(calcularPresentismo(-100, true)).toBe(0);
  });
});

// ─── calcularTotalLiquidacion ────────────────────────────────────────────────

describe("calcularTotalLiquidacion", () => {
  const base = {
    sueldo_mensual: 600000,
    modo_pago: "MENSUAL" as const,
    inasistencias: 0,
    horas_extras: 0,
    dobles: 0,
    valor_doble: 0,
    feriados: 0,
    vacaciones_dias: 0,
    presentismo_mantiene: true,
    adelantos: 0,
    pagos_dobles_realizados: 0,
  };

  it("caso base sin novedades → sueldo + presentismo", () => {
    const r = calcularTotalLiquidacion(base);
    expect(r.sueldo_base).toBe(600000);
    expect(r.monto_presentismo).toBe(30000);
    expect(r.total_a_pagar).toBe(630000);
  });

  it("caso base sin presentismo → sueldo", () => {
    const r = calcularTotalLiquidacion({ ...base, presentismo_mantiene: false });
    expect(r.total_a_pagar).toBe(600000);
  });

  it("con 2 inasistencias → descuenta 2 × valor_dia", () => {
    const r = calcularTotalLiquidacion({ ...base, inasistencias: 2 });
    const descuento = 2 * (600000 / 30);
    expect(r.descuento_ausencias).toBeCloseTo(descuento, 0);
    expect(r.total_a_pagar).toBeCloseTo(600000 - descuento + 30000, 0);
  });

  it("con horas extras → suma correcta", () => {
    const r = calcularTotalLiquidacion({ ...base, horas_extras: 8 });
    const heVal = 8 * (600000 / 30 / 8);
    expect(r.total_horas_extras).toBeCloseTo(heVal, 0);
    expect(r.total_a_pagar).toBeCloseTo(600000 + heVal + 30000, 0);
  });

  it("con dobles → suma dobles × valor_doble", () => {
    const r = calcularTotalLiquidacion({ ...base, dobles: 3, valor_doble: 5000 });
    expect(r.total_dobles).toBe(15000);
    expect(r.total_a_pagar).toBeCloseTo(600000 + 15000 + 30000, 0);
  });

  it("con feriados → suma feriados × valor_dia", () => {
    const r = calcularTotalLiquidacion({ ...base, feriados: 2 });
    const ferVal = 2 * (600000 / 30);
    expect(r.total_feriados).toBeCloseTo(ferVal, 0);
  });

  it("con vacaciones → suma vacaciones_dias × valor_dia_vacacional (sueldo/25 por LCT Art 155)", () => {
    const r = calcularTotalLiquidacion({ ...base, vacaciones_dias: 5 });
    const vacVal = 5 * (600000 / 25);
    expect(r.total_vacaciones).toBeCloseTo(vacVal, 0);
  });

  it("con adelantos → resta correcta", () => {
    const r = calcularTotalLiquidacion({ ...base, adelantos: 50000 });
    expect(r.total_a_pagar).toBeCloseTo(600000 + 30000 - 50000, 0);
  });

  it("con pagos_dobles_realizados → resta correcta", () => {
    const r = calcularTotalLiquidacion({ ...base, pagos_dobles_realizados: 20000 });
    expect(r.total_a_pagar).toBeCloseTo(600000 + 30000 - 20000, 0);
  });

  it("todo combinado → resultado correcto", () => {
    const r = calcularTotalLiquidacion({
      ...base,
      inasistencias: 1,
      horas_extras: 4,
      dobles: 2,
      valor_doble: 5000,
      feriados: 1,
      vacaciones_dias: 3,
      adelantos: 30000,
      pagos_dobles_realizados: 10000,
    });
    const valorDia = 600000 / 30;
    const valorHora = valorDia / 8;
    const valorDiaVacacional = 600000 / 25;
    const expected =
      600000 // sueldo base
      - 1 * valorDia // inasistencias
      + 4 * valorHora // horas extras
      + 2 * 5000 // dobles
      + 1 * valorDia // feriados
      + 3 * valorDiaVacacional // vacaciones (LCT Art 155)
      + 30000 // presentismo
      - 30000 // adelantos
      - 10000; // pagos dobles
    expect(r.total_a_pagar).toBeCloseTo(expected, 0);
  });

  it("modo QUINCENAL → sueldo_base es sueldo/2", () => {
    const r = calcularTotalLiquidacion({ ...base, modo_pago: "QUINCENAL" });
    expect(r.sueldo_base).toBe(300000);
    expect(r.total_a_pagar).toBeCloseTo(300000 + 30000, 0);
  });

  it("modo SEMANAL → sueldo_base es sueldo/4", () => {
    const r = calcularTotalLiquidacion({ ...base, modo_pago: "SEMANAL" });
    expect(r.sueldo_base).toBe(150000);
    expect(r.total_a_pagar).toBeCloseTo(150000 + 30000, 0);
  });
});

// ─── calcularLiquidacionFinal ────────────────────────────────────────────────

describe("calcularLiquidacionFinal", () => {
  const baseFinal = {
    sueldo_mensual: 600000,
    fecha_inicio: "2023-03-01",
    fecha_egreso: "2026-04-15",
    vacaciones_acumuladas: 10,
    motivo: "Renuncia" as const,
  };
  const valorDia = 600000 / 30; // 20000

  it("proporcional del mes → valorDia × día del mes", () => {
    const r = calcularLiquidacionFinal(baseFinal);
    // egreso día 15 → 15 × valorDia
    expect(r.proporcional_mes).toBeCloseTo(valorDia * 15, 0);
  });

  it("vacaciones no tomadas en dinero → días × (sueldo/25) (LCT Art 155)", () => {
    const r = calcularLiquidacionFinal(baseFinal);
    const valorDiaVacacional = 600000 / 25; // 24000
    expect(r.vacaciones_dinero).toBeCloseTo(10 * valorDiaVacacional, 0);
  });

  it("SAC proporcional al semestre", () => {
    const r = calcularLiquidacionFinal(baseFinal);
    // Egreso 15/04: semestre 1, desde 01/01 al 15/04
    // Días en semestre ≈ 105
    const inicioSem = new Date(2026, 0, 1);
    const fechaEg = new Date("2026-04-15T12:00:00");
    const diasEnSem = Math.ceil((fechaEg.getTime() - inicioSem.getTime()) / 86400000);
    const sacEsperado = (600000 / 2) * (diasEnSem / 180);
    expect(r.sac_proporcional).toBeCloseTo(sacEsperado, 0);
  });

  it("renuncia → sin indemnización, preaviso ni integración", () => {
    const r = calcularLiquidacionFinal(baseFinal);
    expect(r.indemnizacion).toBe(0);
    expect(r.preaviso).toBe(0);
    expect(r.integracion_mes).toBe(0);
  });

  it("despido sin causa → indemnización = sueldo × años", () => {
    const r = calcularLiquidacionFinal({ ...baseFinal, motivo: "Despido sin causa" });
    // Antigüedad: 2023-03 a 2026-04 ≈ 3 años
    expect(r.indemnizacion).toBe(600000 * 3);
  });

  it("despido sin causa < 5 años → preaviso = 15 días", () => {
    const r = calcularLiquidacionFinal({ ...baseFinal, motivo: "Despido sin causa" });
    expect(r.preaviso).toBeCloseTo(valorDia * 15, 0);
  });

  it("despido sin causa >= 5 años → preaviso = 1 sueldo", () => {
    const r = calcularLiquidacionFinal({
      ...baseFinal,
      fecha_inicio: "2020-01-01",
      motivo: "Despido sin causa",
    });
    // Antigüedad: 2020-01 a 2026-04 = 6 años
    expect(r.preaviso).toBe(600000);
  });

  it("despido sin causa → integración = días restantes del mes × valorDia", () => {
    const r = calcularLiquidacionFinal({ ...baseFinal, motivo: "Despido sin causa" });
    // Abril tiene 30 días, egreso día 15 → 15 restantes
    expect(r.integracion_mes).toBeCloseTo(valorDia * 15, 0);
  });

  it("despido con causa → sin indemnización", () => {
    const r = calcularLiquidacionFinal({ ...baseFinal, motivo: "Despido con causa" });
    expect(r.indemnizacion).toBe(0);
    expect(r.preaviso).toBe(0);
    expect(r.integracion_mes).toBe(0);
  });

  it("total nunca negativo", () => {
    const r = calcularLiquidacionFinal({
      ...baseFinal,
      vacaciones_acumuladas: 0,
    });
    expect(r.total).toBeGreaterThanOrEqual(0);
  });

  it("vacaciones_acumuladas negativas → se clampea a 0", () => {
    const r = calcularLiquidacionFinal({
      ...baseFinal,
      vacaciones_acumuladas: -5,
    });
    expect(r.vacaciones_dinero).toBe(0);
  });

  it("egreso en semestre 2 → SAC calcula desde julio", () => {
    const r = calcularLiquidacionFinal({
      ...baseFinal,
      fecha_egreso: "2026-09-15",
    });
    const inicioSem = new Date(2026, 6, 1); // julio
    const fechaEg = new Date("2026-09-15T12:00:00");
    const diasEnSem = Math.ceil((fechaEg.getTime() - inicioSem.getTime()) / 86400000);
    const sacEsperado = (600000 / 2) * (diasEnSem / 180);
    expect(r.sac_proporcional).toBeCloseTo(sacEsperado, 0);
  });

  it("total suma todos los conceptos correctamente", () => {
    const r = calcularLiquidacionFinal({ ...baseFinal, motivo: "Despido sin causa" });
    const sumaManual =
      r.proporcional_mes + r.vacaciones_dinero + r.sac_proporcional +
      r.indemnizacion + r.preaviso + r.integracion_mes;
    expect(r.total).toBeCloseTo(sumaManual, 0);
  });
});
