import { describe, it, expect } from "vitest";
import { money, pctOf, mesLabel, asignarColores, svgDonut } from "./cierreCharts";

describe("cierreCharts", () => {
  it("money formatea AR con signo", () => {
    expect(money(106765435.5)).toBe("$106.765.435,50");
    expect(money(-39160853.4)).toBe("−$39.160.853,40");
    expect(money(0)).toBe("$0,00");
  });
  it("pctOf sobre base, '—' si base ≤ 0", () => {
    expect(pctOf(39160853.4, 106765435.5)).toBe("36,7%");
    expect(pctOf(100, 0)).toBe("—");
  });
  it("mesLabel a español", () => {
    expect(mesLabel("2026-05")).toBe("Mayo 2026");
  });
  it("asignarColores agrupa el sobrante en 'Otros' segun maxSlices", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ label: "C" + i, value: 12 - i }));
    const r = asignarColores(items, 8);
    expect(r.length).toBe(8);
    expect(r[7]!.label).toBe("Otros");
    expect(r[7]!.value).toBe(5 + 4 + 3 + 2 + 1); // sobrante (indices 7..11) = 15
    expect(r.every((s) => /^#/.test(s.color))).toBe(true);
  });
  it("asignarColores no agrupa si entra en maxSlices", () => {
    const items = [{ label: "A", value: 3 }, { label: "B", value: 1 }];
    expect(asignarColores(items, 8).length).toBe(2);
  });
  it("svgDonut devuelve un <svg> con un path por segmento", () => {
    const svg = svgDonut([{ label: "A", value: 1, color: "#75AADB" }, { label: "B", value: 1, color: "#E0795F" }], 200);
    expect(svg.startsWith("<svg")).toBe(true);
    expect((svg.match(/<path/g) || []).length).toBe(2);
  });
});
