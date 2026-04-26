import { describe, it, expect } from "vitest";

// Test unitario de la función pura de mapeo de filas a arrays por tipo.
// Reimporta la lógica duplicada en este archivo para testearla sin mockear
// Supabase. useCategorias() en sí requiere entorno React y se testea con
// Playwright e2e cuando haga falta (fuera de scope).

function fromRows(rows: { tipo: string; nombre: string; orden: number; grupo: string | null; activo: boolean }[]) {
  const byTipo = (t: string) => rows
    .filter(r => r.tipo === t && r.activo)
    .sort((a, b) => (a.orden || 0) - (b.orden || 0))
    .map(r => r.nombre);
  return {
    CATEGORIAS_COMPRA: byTipo("cat_compra"),
    GASTOS_FIJOS: byTipo("gasto_fijo"),
    GASTOS_VARIABLES: byTipo("gasto_variable"),
    GASTOS_PUBLICIDAD: byTipo("gasto_publicidad"),
    COMISIONES_CATS: byTipo("gasto_comision"),
    GASTOS_IMPUESTOS: byTipo("gasto_impuesto"),
    CATEGORIAS_INGRESO: byTipo("cat_ingreso"),
  };
}

describe("fromRows (useCategorias mapping)", () => {
  it("ordena por orden ascendente", () => {
    const rows = [
      { tipo: "cat_compra", nombre: "C", orden: 3, grupo: "CMV", activo: true },
      { tipo: "cat_compra", nombre: "A", orden: 1, grupo: "CMV", activo: true },
      { tipo: "cat_compra", nombre: "B", orden: 2, grupo: "CMV", activo: true },
    ];
    expect(fromRows(rows).CATEGORIAS_COMPRA).toEqual(["A", "B", "C"]);
  });

  it("filtra inactivas", () => {
    const rows = [
      { tipo: "gasto_fijo", nombre: "ALQUILER", orden: 1, grupo: "Gastos Fijos", activo: true },
      { tipo: "gasto_fijo", nombre: "DISCONTINUED", orden: 2, grupo: "Gastos Fijos", activo: false },
    ];
    expect(fromRows(rows).GASTOS_FIJOS).toEqual(["ALQUILER"]);
  });

  it("separa por tipo", () => {
    const rows = [
      { tipo: "cat_compra", nombre: "PESCADERIA", orden: 1, grupo: "CMV", activo: true },
      { tipo: "gasto_fijo", nombre: "ALQUILER", orden: 1, grupo: "Gastos Fijos", activo: true },
      { tipo: "cat_ingreso", nombre: "Liquidación Rappi", orden: 1, grupo: "INGRESOS", activo: true },
    ];
    const r = fromRows(rows);
    expect(r.CATEGORIAS_COMPRA).toEqual(["PESCADERIA"]);
    expect(r.GASTOS_FIJOS).toEqual(["ALQUILER"]);
    expect(r.CATEGORIAS_INGRESO).toEqual(["Liquidación Rappi"]);
    expect(r.GASTOS_VARIABLES).toEqual([]);
  });

  it("array vacío si no hay filas de ese tipo", () => {
    expect(fromRows([]).CATEGORIAS_COMPRA).toEqual([]);
  });
});
