import { describe, it, expect } from "vitest";
import { refsDevueltas } from "./conciliacionDevueltas";
import type { ExtractoMovimiento } from "./mpExtractoParser";

function mov(p: Partial<ExtractoMovimiento>): ExtractoMovimiento {
  return {
    fecha: "2026-05-15",
    monto: 0,
    tipo: "transferencia",
    descripcion: "TRANSFER",
    referencia_externa: null,
    ...p,
  };
}

describe("refsDevueltas", () => {
  it("detecta un par envío+devolución con misma ref y montos opuestos", () => {
    const movs = [
      mov({ monto: -119569.54, referencia_externa: "158658195423" }),
      mov({ monto: 119569.54, referencia_externa: "158658195423" }),
    ];
    const refs = refsDevueltas(movs);
    expect(refs.has("158658195423")).toBe(true);
    expect(refs.size).toBe(1);
  });

  it("NO marca un egreso sin su devolución", () => {
    const movs = [mov({ monto: -50000, referencia_externa: "AAA" })];
    expect(refsDevueltas(movs).size).toBe(0);
  });

  it("NO marca un ingreso suelto (devolución sin egreso correspondiente)", () => {
    const movs = [mov({ monto: 50000, referencia_externa: "BBB" })];
    expect(refsDevueltas(movs).size).toBe(0);
  });

  it("ignora movimientos sin referencia_externa aunque netee", () => {
    const movs = [
      mov({ monto: -50000, referencia_externa: null }),
      mov({ monto: 50000, referencia_externa: null }),
    ];
    expect(refsDevueltas(movs).size).toBe(0);
  });

  it("NO marca cuando los montos no coinciden (egreso parcialmente reintegrado)", () => {
    const movs = [
      mov({ monto: -100000, referencia_externa: "CCC" }),
      mov({ monto: 40000, referencia_externa: "CCC" }),
    ];
    expect(refsDevueltas(movs).size).toBe(0);
  });

  it("tolera diferencia de centavos (< $1) por redondeo", () => {
    const movs = [
      mov({ monto: -119569.54, referencia_externa: "DDD" }),
      mov({ monto: 119569.0, referencia_externa: "DDD" }),
    ];
    expect(refsDevueltas(movs).has("DDD")).toBe(true);
  });

  it("maneja varias refs mezcladas y devuelve solo las neteadas", () => {
    const movs = [
      mov({ monto: -10000, referencia_externa: "R1" }), // devuelta
      mov({ monto: 10000, referencia_externa: "R1" }),
      mov({ monto: -20000, referencia_externa: "R2" }), // pago real, no vuelve
      mov({ monto: 30000, referencia_externa: "R3" }), // ingreso real
    ];
    const refs = refsDevueltas(movs);
    expect([...refs]).toEqual(["R1"]);
  });
});
