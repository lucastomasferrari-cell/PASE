import { describe, it, expect } from "vitest";
import { ordenarPorCategoria } from "./eerrDetalle";

describe("ordenarPorCategoria", () => {
  const CAT = ["ENVIOS", "BAZAR", "PACKAGING"];

  it("incluye categorías huérfanas (no están en el catálogo) — bug 21-jun", () => {
    const rows = ordenarPorCategoria(
      [
        { cat: "ENVIOS", monto: 100 },
        { cat: "REPARTIDORES", monto: 3000 }, // huérfana
        { cat: "Sueldo evento", monto: 1900 }, // huérfana
      ],
      CAT,
    );
    const total = rows.reduce((s, r) => s + r.t, 0);
    expect(total).toBe(5000); // detalle == total (no se pierde plata)
    expect(rows.map(r => r.c)).toContain("REPARTIDORES");
    expect(rows.map(r => r.c)).toContain("Sueldo evento");
  });

  it("ordena: catálogo primero (en su orden), huérfanas después por monto desc", () => {
    const rows = ordenarPorCategoria(
      [
        { cat: "PACKAGING", monto: 10 }, // catálogo idx 2
        { cat: "ENVIOS", monto: 10 }, // catálogo idx 0
        { cat: "BAZAR", monto: 10 }, // catálogo idx 1
        { cat: "REPARTIDORES", monto: 50 }, // huérfana grande
        { cat: "PROPINA", monto: 80 }, // huérfana más grande
      ],
      CAT,
    );
    expect(rows.map(r => r.c)).toEqual([
      "ENVIOS", "BAZAR", "PACKAGING", // catálogo en orden
      "PROPINA", "REPARTIDORES", // huérfanas por monto desc
    ]);
  });

  it("agrupa montos de la misma categoría", () => {
    const rows = ordenarPorCategoria(
      [
        { cat: "ENVIOS", monto: 100 },
        { cat: "ENVIOS", monto: 250 },
      ],
      CAT,
    );
    expect(rows).toEqual([{ c: "ENVIOS", t: 350 }]);
  });

  it("manda las categorías vacías/null a 'Sin categoría'", () => {
    const rows = ordenarPorCategoria(
      [
        { cat: null, monto: 40 },
        { cat: "", monto: 60 },
        { cat: undefined, monto: 5 },
      ],
      CAT,
    );
    expect(rows).toEqual([{ c: "Sin categoría", t: 105 }]);
  });

  it("descarta las líneas de monto ~0", () => {
    const rows = ordenarPorCategoria(
      [
        { cat: "ENVIOS", monto: 100 },
        { cat: "BAZAR", monto: 0 },
      ],
      CAT,
    );
    expect(rows.map(r => r.c)).toEqual(["ENVIOS"]);
  });

  it("suma de líneas == suma de ítems de entrada (invariante de cuadre)", () => {
    const items = [
      { cat: "ENVIOS", monto: 123.45 },
      { cat: "X", monto: 678.9 },
      { cat: "BAZAR", monto: 1000 },
      { cat: null, monto: 55.55 },
    ];
    const rows = ordenarPorCategoria(items, CAT);
    const totalItems = items.reduce((s, i) => s + i.monto, 0);
    const totalRows = rows.reduce((s, r) => s + r.t, 0);
    expect(totalRows).toBeCloseTo(totalItems, 2);
  });
});
