# EERR — Presentación de cierre (PDF + PPTX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) o superpowers:executing-plans para ejecutar task-by-task. Steps usan checkbox `- [ ]`.

**Goal:** Que el botón "Exportar" de Reportes/EERR ofrezca una presentación de cierre de 6 slides (del local+mes elegidos, con comparación al mes anterior) en PDF terminado y en PowerPoint editable, con datos 100% de PASE.

**Architecture:** Módulo nuevo `packages/pase/src/lib/cierre/`. Una capa de datos **pura** (`cierreData.ts::assembleCierre` → `CierreModel`) que NO hace I/O, alimentada por los valores que `EERR.tsx` ya computa + el resumen del mes anterior + los socios. Dos renderers que consumen el mismo `CierreModel`: `cierrePdf.ts` (HTML landscape → html2canvas → jsPDF) y `cierrePptx.ts` (PptxGenJS, slides + charts nativos). Helpers compartidos (paleta, formatos, SVG de torta/dona) en `cierreCharts.ts`. Todo frontend, sin DB ni migraciones.

**Tech Stack:** React 19 + Vite + TS estricto. vitest. `jspdf` + `html2canvas` (ya instaladas), `pptxgenjs` (nueva, import dinámico). Spec: `docs/superpowers/specs/2026-06-21-eerr-cierre-presentacion-export-design.md`.

---

## File Structure
- **Create** `src/lib/cierre/cierreCharts.ts` — paleta de colores legible, formatos `$`/`%`, label de mes, generador SVG de torta/dona, asignación de colores con agrupación "Otros".
- **Create** `src/lib/cierre/cierreCharts.test.ts` — tests de formatos + SVG + agrupación.
- **Create** `src/lib/cierre/cierreData.ts` — tipos (`CierreInput`, `CierreModel`, `Slice`, …) + `assembleCierre(input): CierreModel` (puro).
- **Create** `src/lib/cierre/cierreData.test.ts` — tests del modelo (totales, %, comparación, socios, edge cases).
- **Create** `src/lib/cierre/cierrePdf.ts` — `exportCierrePdf(model)`: 6 slides HTML landscape → PDF.
- **Create** `src/lib/cierre/cierrePptx.ts` — `exportCierrePptx(model)`: 6 slides PptxGenJS.
- **Modify** `src/pages/EERR.tsx` — botón Exportar → menú de 3 opciones; juntar prev-resumen + socios y llamar al renderer.
- **Modify** `package.json` — `pptxgenjs`.

---

## Task 1: Helpers de charts y formato (`cierreCharts.ts`)

**Files:** Create `src/lib/cierre/cierreCharts.ts`, `src/lib/cierre/cierreCharts.test.ts`

- [ ] **Step 1: Escribir el test** — `src/lib/cierre/cierreCharts.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { money, pctOf, mesLabel, asignarColores, svgDonut } from "./cierreCharts";

describe("cierreCharts", () => {
  it("money formatea AR con signo", () => {
    expect(money(106765435.5)).toBe("$106.765.435,50");
    expect(money(-39160853.4)).toBe("−$39.160.853,40");
    expect(money(0)).toBe("$0,00");
  });
  it("pctOf sobre base, '—' si base 0", () => {
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
    expect(r[7]!.value).toBe(4 + 3 + 2 + 1 + 1); // C7..C11 + (value de C7=5)… ver impl
    expect(r.every((s) => /^#/.test(s.color))).toBe(true);
  });
  it("svgDonut devuelve un <svg> con un path por segmento", () => {
    const svg = svgDonut([{ label: "A", value: 1, color: "#75AADB" }, { label: "B", value: 1, color: "#E0795F" }], 200);
    expect(svg.startsWith("<svg")).toBe(true);
    expect((svg.match(/<path/g) || []).length).toBe(2);
  });
});
```

- [ ] **Step 2: Correr y ver fallar** — `pnpm --filter pase test -- src/lib/cierre/cierreCharts.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 3: Implementar** — `src/lib/cierre/cierreCharts.ts`

```ts
// Helpers compartidos del export de cierre: formato, paleta y SVG de charts.

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
export function mesLabel(mes: string): string {
  const [yr, mo] = mes.split("-").map(Number);
  return `${MESES[(mo ?? 1) - 1]} ${yr}`;
}

/** $1.234.567,89 con − para negativos. */
export function money(n: number, dec = 2): string {
  const neg = n < 0;
  const s = Math.abs(n).toLocaleString("es-AR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (neg ? "−$" : "$") + s;
}
/** Porcentaje de n sobre base; "—" si base ≤ 0. */
export function pctOf(n: number, base: number): string {
  if (base <= 0) return "—";
  return (n / base * 100).toFixed(1).replace(".", ",") + "%";
}

// Paleta anclada en celeste PASE, legible para charts con muchas categorías.
export const CHART_COLORS = [
  "#75AADB", "#3F8F9D", "#5B6B85", "#E0795F", "#E3B23C", "#5BA67A",
  "#8B7BB0", "#C95B7B", "#4F7CAC", "#9DC3E2", "#B0855B", "#6E8CAB",
];

export interface ColoredSlice { label: string; value: number; color: string; }

/**
 * Asigna colores estables por orden. Si hay más de `maxSlices`, agrupa el
 * sobrante en un segmento "Otros" (gris). Espera items ya ordenados desc.
 */
export function asignarColores(items: { label: string; value: number }[], maxSlices = 8): ColoredSlice[] {
  if (items.length <= maxSlices) {
    return items.map((it, i) => ({ ...it, color: CHART_COLORS[i % CHART_COLORS.length]! }));
  }
  const keep = items.slice(0, maxSlices - 1).map((it, i) => ({ ...it, color: CHART_COLORS[i % CHART_COLORS.length]! }));
  const restoValue = items.slice(maxSlices - 1).reduce((s, x) => s + x.value, 0);
  keep.push({ label: "Otros", value: restoValue, color: "#B6C2D1" });
  return keep;
}

/** SVG de dona (ring). `size` = lado del viewBox. Sin labels (van en la lista al lado). */
export function svgDonut(slices: ColoredSlice[], size = 260, innerRatio = 0.58): string {
  return svgPieBase(slices, size, innerRatio);
}
/** SVG de torta llena. */
export function svgPie(slices: ColoredSlice[], size = 260): string {
  return svgPieBase(slices, size, 0);
}

function svgPieBase(slices: ColoredSlice[], size: number, innerRatio: number): string {
  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  const cx = size / 2, cy = size / 2, r = size / 2 - 2;
  if (total <= 0) return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  let a0 = -Math.PI / 2; // arranca arriba
  const paths = slices.map((s) => {
    const frac = Math.max(0, s.value) / total;
    const a1 = a0 + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const d = `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
    a0 = a1;
    return `<path d="${d}" fill="${s.color}"/>`;
  }).join("");
  const hole = innerRatio > 0
    ? `<circle cx="${cx}" cy="${cy}" r="${(r * innerRatio).toFixed(2)}" fill="#FFFFFF"/>`
    : "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">${paths}${hole}</svg>`;
}
```

> Nota impl: ajustar el `expect` de "Otros" en el test si difiere; lo importante es que agrupe el sobrante y que cada slice tenga color `#…`.

- [ ] **Step 4: Correr y pasar** — `pnpm --filter pase test -- src/lib/cierre/cierreCharts.test.ts` → PASS. Si el monto exacto del "Otros" no coincide, corregir el test al valor real (suma de `value` desde index 7).

- [ ] **Step 5: Commit**

```bash
git add packages/pase/src/lib/cierre/cierreCharts.ts packages/pase/src/lib/cierre/cierreCharts.test.ts
git commit -m "feat(cierre): helpers de chart y formato para el export de cierre"
```

---

## Task 2: Capa de datos pura (`cierreData.ts`)

**Files:** Create `src/lib/cierre/cierreData.ts`, `src/lib/cierre/cierreData.test.ts`

- [ ] **Step 1: Escribir el test** — `src/lib/cierre/cierreData.test.ts`

```ts
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
    expect(m.division!.items[0]).toMatchObject({ nombre: "David", montoFmt: "$15.237.512,02" });
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
  it("ventas 0 (apertura) → % '—', sin NaN/Infinity", () => {
    const m = assembleCierre({ ...base, ventas: 0 });
    const s = JSON.stringify(m);
    expect(s).not.toContain("NaN");
    expect(s).not.toContain("Infinity");
    expect(m.cmv.pctVentas).toBe("—");
  });
});
```

- [ ] **Step 2: Correr y ver fallar** — `pnpm --filter pase test -- src/lib/cierre/cierreData.test.ts` → FAIL.

- [ ] **Step 3: Implementar** — `src/lib/cierre/cierreData.ts`

```ts
import { money, pctOf, mesLabel, asignarColores, type ColoredSlice } from "./cierreCharts";

export interface MesResumenLite {
  ventas: number; cmv: number; gastosFijos: number; gastosVar: number;
  publicidad: number; comisiones: number; impuestos: number; otrosGastos: number;
  sueldos: number; cargasSociales: number; utilNeta: number;
}
export interface SocioLite { nombre: string; porcentaje: number; }
export interface CierreInput {
  localNombre: string; mes: string; emitido: string;
  ventas: number; cmv: number; utilBruta: number;
  gastosFijosVar: number; sueldos: number; cargas: number; boletas: number;
  publicidad: number; comisiones: number; impuestos: number; otros: number; utilNeta: number;
  porMedio: { label: string; value: number }[];
  cmvPorCat: { label: string; value: number }[];
  gastosPorCat: { label: string; value: number }[];
  prev: MesResumenLite | null;
  prevMes: string | null;
  socios: SocioLite[];
}

export interface ListItem { label: string; valueFmt: string; pct: string; }
export interface ChartSlice extends ColoredSlice { valueFmt: string; pct: string; }
export interface CierreModel {
  emitido: string;
  portada: { localNombre: string; mesLabel: string };
  ingresos: { totalFmt: string; prevLabel: string | null; prevFmt: string | null; items: ListItem[]; chart: ChartSlice[] };
  cmv: { pctVentas: string; prevPct: string | null; items: ListItem[]; chart: ChartSlice[]; totalFmt: string; utilBrutaPct: string };
  gastos: { pctVentas: string; prevPct: string | null; items: ListItem[]; chart: ChartSlice[]; totalFmt: string };
  resumen: { lines: { label: string; pct: string; montoFmt: string }[]; totalGastosFmt: string; rentabilidadFmt: string; rentabilidadPct: string };
  division: { rentabilidadFmt: string; items: { nombre: string; pct: string; montoFmt: string }[] } | null;
}

function toList(items: { label: string; value: number }[], base: number): ListItem[] {
  return items.map((x) => ({ label: x.label, valueFmt: money(x.value), pct: pctOf(x.value, base) }));
}
function toChart(items: { label: string; value: number }[], base: number, maxSlices = 8): ChartSlice[] {
  return asignarColores(items, maxSlices).map((s) => ({ ...s, valueFmt: money(s.value), pct: pctOf(s.value, base) }));
}

export function assembleCierre(i: CierreInput): CierreModel {
  const v = i.ventas;
  const costoLaboral = i.sueldos + i.cargas + i.boletas;
  const totalGastos = v - i.utilNeta; // CMV + todos los egresos
  const prevVentas = i.prev?.ventas ?? 0;
  const prevGastosFV = i.prev ? i.prev.gastosFijos + i.prev.gastosVar : 0;

  const division = (i.socios.length > 0 && i.utilNeta > 0)
    ? {
        rentabilidadFmt: money(i.utilNeta),
        items: i.socios.map((s) => ({
          nombre: s.nombre,
          pct: s.porcentaje.toLocaleString("es-AR") + "%",
          montoFmt: money(i.utilNeta * s.porcentaje / 100),
        })),
      }
    : null;

  return {
    emitido: i.emitido,
    portada: { localNombre: i.localNombre, mesLabel: mesLabel(i.mes) },
    ingresos: {
      totalFmt: money(v),
      prevLabel: i.prevMes ? mesLabel(i.prevMes) : null,
      prevFmt: i.prev ? money(i.prev.ventas) : null,
      items: toList(i.porMedio, v),
      chart: toChart(i.porMedio, v),
    },
    cmv: {
      pctVentas: pctOf(i.cmv, v),
      prevPct: i.prev ? pctOf(i.prev.cmv, prevVentas) : null,
      items: toList(i.cmvPorCat, v),
      chart: toChart(i.cmvPorCat, i.cmv),
      totalFmt: money(i.cmv),
      utilBrutaPct: pctOf(i.utilBruta, v),
    },
    gastos: {
      pctVentas: pctOf(i.gastosFijosVar, v),
      prevPct: i.prev ? pctOf(prevGastosFV, prevVentas) : null,
      items: toList(i.gastosPorCat, v),
      chart: toChart(i.gastosPorCat, i.gastosFijosVar),
      totalFmt: money(i.gastosFijosVar),
    },
    resumen: {
      lines: [
        { label: "Gastos de marketing", pct: pctOf(i.publicidad, v), montoFmt: money(i.publicidad) },
        { label: "Gastos de personal", pct: pctOf(costoLaboral, v), montoFmt: money(costoLaboral) },
        { label: "Comisiones apps y bancos", pct: pctOf(i.comisiones, v), montoFmt: money(i.comisiones) },
        { label: "Impuestos", pct: pctOf(i.impuestos, v), montoFmt: money(i.impuestos) },
      ],
      totalGastosFmt: money(totalGastos),
      rentabilidadFmt: money(i.utilNeta),
      rentabilidadPct: pctOf(i.utilNeta, v),
    },
    division,
  };
}
```

- [ ] **Step 4: Correr y pasar** — `pnpm --filter pase test -- src/lib/cierre/cierreData.test.ts` → PASS. (Ajustar montos esperados del test si la aritmética da decimales distintos; los valores de arriba están calculados con los datos del fixture.)

- [ ] **Step 5: Commit**

```bash
git add packages/pase/src/lib/cierre/cierreData.ts packages/pase/src/lib/cierre/cierreData.test.ts
git commit -m "feat(cierre): capa de datos pura assembleCierre + tests"
```

---

## Task 3: Renderer PDF (`cierrePdf.ts`)

**Files:** Create `src/lib/cierre/cierrePdf.ts`

Reusa el enfoque de `src/lib/exportEERRPdf.ts` (HTML inline con CSS scopeado + html2canvas + jsPDF), pero **landscape 16:9** y **6 páginas** (una por slide). Estética PASE (celeste `#75AADB`, texto `#1A3A5E`, Inter, 0.5px, sin gradientes). Charts via `svgPie`/`svgDonut`.

- [ ] **Step 1: Implementar** — `src/lib/cierre/cierrePdf.ts`

```ts
import type { CierreModel, ChartSlice, ListItem } from "./cierreData";
import { svgPie, svgDonut } from "./cierreCharts";

const W = 1280, H = 720; // 16:9 px (escala a A4 landscape al imprimir)
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

function leyenda(chart: ChartSlice[]): string {
  return chart.map((s) => `<div style="display:flex;align-items:center;gap:6px;font-size:13px;color:#1A3A5E">
    <span style="width:10px;height:10px;border-radius:2px;background:${s.color};display:inline-block"></span>
    <span style="flex:1">${esc(s.label)}</span><span style="color:#6E8CAB">${s.pct}</span></div>`).join("");
}
function listaMontos(items: ListItem[]): string {
  return items.map((x) => `<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;color:#1A3A5E">
    <span>${esc(x.label)}</span><span style="font-variant-numeric:tabular-nums">${x.valueFmt}</span></div>`).join("");
}

// Cada slide es un <div class="slide"> de 1280x720. Devuelve array de HTML.
function slidesHtml(m: CierreModel): string[] {
  const headTitle = (t: string, sub?: string) => `<div style="margin-bottom:18px">
    <div style="font-size:30px;font-weight:500;letter-spacing:-0.02em;color:#1A3A5E">${esc(t)}</div>
    ${sub ? `<div style="font-size:15px;color:#6E8CAB;margin-top:4px">${sub}</div>` : ""}
    <div style="width:54px;height:4px;background:#75AADB;border-radius:2px;margin-top:10px"></div></div>`;

  // 1. Portada (fondo celeste pleno).
  const s1 = `<div class="slide" style="background:#75AADB;color:#fff;display:flex;flex-direction:column;justify-content:center;padding:0 90px">
    <div style="width:8px;height:120px;background:#fff;opacity:.85;border-radius:3px;margin-bottom:26px"></div>
    <div style="font-size:58px;font-weight:500;letter-spacing:-0.02em;line-height:1.05">EERR · ${esc(m.portada.localNombre)}</div>
    <div style="font-size:26px;opacity:.9;margin-top:14px">${esc(m.portada.mesLabel)}</div></div>`;

  // 2. Ingresos.
  const s2 = `<div class="slide" style="${SLIDE_BG};display:flex;flex-direction:column">
    ${headTitle("Ingresos")}
    <div style="display:flex;gap:50px;flex:1">
      <div style="flex:1.05">
        <div style="font-size:40px;font-weight:500;letter-spacing:-0.03em;color:#1A3A5E">${m.ingresos.totalFmt}</div>
        ${m.ingresos.prevFmt ? `<div style="font-size:15px;color:#75AADB;margin-top:4px">${esc(m.ingresos.prevLabel || "")}: ${m.ingresos.prevFmt}</div>` : ""}
        <div style="margin-top:22px">${listaMontos(m.ingresos.items)}</div>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
        ${svgPie(m.ingresos.chart, 300)}
        <div style="width:100%;margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:4px 18px">${leyenda(m.ingresos.chart)}</div>
      </div>
    </div></div>`;

  // 3. CMV (dona).
  const s3 = `<div class="slide" style="${SLIDE_BG};display:flex;flex-direction:column">
    ${headTitle("Egresos · Costo de mercadería (CMV)", `${m.cmv.pctVentas} sobre ventas${m.cmv.prevPct ? ` &nbsp;·&nbsp; ${esc(m.ingresos.prevLabel || "mes ant.")}: ${m.cmv.prevPct}` : ""}`)}
    <div style="display:flex;gap:50px;flex:1">
      <div style="flex:1.05">${listaMontos(m.cmv.items)}
        <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:500;border-top:0.5px solid #DCE8F4;margin-top:8px;padding-top:8px;color:#1A3A5E"><span>Total CMV</span><span>${m.cmv.totalFmt}</span></div>
        <div style="font-size:15px;color:#75AADB;margin-top:12px">Utilidad bruta: ${m.cmv.utilBrutaPct}</div></div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
        ${svgDonut(m.cmv.chart, 300)}
        <div style="width:100%;margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:4px 18px">${leyenda(m.cmv.chart)}</div>
      </div>
    </div></div>`;

  // 4. Gastos fijos y varios (dona).
  const s4 = `<div class="slide" style="${SLIDE_BG};display:flex;flex-direction:column">
    ${headTitle("Egresos · Gastos fijos y varios", `${m.gastos.pctVentas} sobre ventas${m.gastos.prevPct ? ` &nbsp;·&nbsp; ${esc(m.ingresos.prevLabel || "mes ant.")}: ${m.gastos.prevPct}` : ""}`)}
    <div style="display:flex;gap:50px;flex:1">
      <div style="flex:1.05">${listaMontos(m.gastos.items)}
        <div style="display:flex;justify-content:space-between;font-size:14px;font-weight:500;border-top:0.5px solid #DCE8F4;margin-top:8px;padding-top:8px;color:#1A3A5E"><span>Total</span><span>${m.gastos.totalFmt}</span></div></div>
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
        ${svgDonut(m.gastos.chart, 300)}
        <div style="width:100%;margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:4px 18px">${leyenda(m.gastos.chart)}</div>
      </div>
    </div></div>`;

  // 5. Resumen de egresos.
  const s5 = `<div class="slide" style="${SLIDE_BG};display:flex;flex-direction:column">
    ${headTitle("Egresos · Resumen")}
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:16px">
      ${m.resumen.lines.map((l) => `<div style="display:flex;justify-content:space-between;align-items:baseline;font-size:19px;color:#1A3A5E">
        <span>${esc(l.label)}: <b style="font-weight:500;color:#75AADB">${l.pct}</b></span><span style="font-variant-numeric:tabular-nums">${l.montoFmt}</span></div>`).join("")}
      <div style="border-top:0.5px solid #DCE8F4;margin-top:10px;padding-top:16px;display:flex;justify-content:space-between;font-size:21px;font-weight:500;color:#1A3A5E"><span>Total de gastos</span><span>${m.resumen.totalGastosFmt}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:24px;font-weight:500;color:#157a5b"><span>Rentabilidad final: ${m.resumen.rentabilidadPct}</span><span>${m.resumen.rentabilidadFmt}</span></div>
    </div></div>`;

  // 6. División de ganancias (si hay).
  const s6 = m.division ? `<div class="slide" style="${SLIDE_BG};display:flex;flex-direction:column">
    ${headTitle("División de ganancias")}
    <div style="font-size:17px;color:#157a5b;margin-bottom:10px">Rentabilidad: ${m.division.rentabilidadFmt}</div>
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:12px;max-width:560px">
      ${m.division.items.map((d) => `<div style="display:flex;justify-content:space-between;font-size:20px;color:#1A3A5E">
        <span>${esc(d.nombre)} <span style="color:#6E8CAB;font-size:15px">(${d.pct})</span></span><span style="font-variant-numeric:tabular-nums">${d.montoFmt}</span></div>`).join("")}
    </div></div>` : "";

  return [s1, s2, s3, s4, s5, s6].filter(Boolean);
}

const SLIDE_BG = "background:#F4F9FD;padding:54px 64px";

export async function exportCierrePdf(model: CierreModel): Promise<void> {
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([import("jspdf"), import("html2canvas")]);
  const pdf = new jsPDF({ unit: "px", format: [W, H], orientation: "landscape" });
  const slides = slidesHtml(model);
  for (let idx = 0; idx < slides.length; idx++) {
    const host = document.createElement("div");
    host.style.cssText = `position:fixed;left:-10000px;top:0;width:${W}px;height:${H}px;font-family:'Inter',system-ui,sans-serif;`;
    host.innerHTML = `<div style="width:${W}px;height:${H}px;box-sizing:border-box;overflow:hidden">${slides[idx]}</div>`;
    document.body.appendChild(host);
    try {
      if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* noop */ } }
      const canvas = await html2canvas(host.firstElementChild as HTMLElement, { scale: 2, backgroundColor: "#ffffff", logging: false, width: W, height: H });
      if (idx > 0) pdf.addPage([W, H], "landscape");
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, W, H);
    } finally {
      document.body.removeChild(host);
    }
  }
  pdf.save(`Cierre_${model.portada.localNombre.replace(/[^\w]+/g, "-")}_${model.portada.mesLabel.replace(/\s/g, "-")}.pdf`);
}
```

- [ ] **Step 2: typecheck** — `pnpm --filter pase typecheck` → sin errores.
- [ ] **Step 3: Commit**

```bash
git add packages/pase/src/lib/cierre/cierrePdf.ts
git commit -m "feat(cierre): renderer PDF de la presentacion (6 slides landscape)"
```

---

## Task 4: Renderer PPTX (`cierrePptx.ts`)

**Files:** Create `src/lib/cierre/cierrePptx.ts`. **Modify** `package.json` (dep `pptxgenjs`).

- [ ] **Step 1: Agregar dependencia**

Run: `pnpm --filter pase add pptxgenjs`
Expected: agrega `pptxgenjs` a `packages/pase/package.json`.

- [ ] **Step 2: Implementar** — `src/lib/cierre/cierrePptx.ts`

PptxGenJS usa pulgadas (slide 13.33×7.5 = 16:9). Colores sin `#`. Charts nativos `pie`/`doughnut` (editables en PowerPoint).

```ts
import type { CierreModel, ChartSlice } from "./cierreData";

const CEL = "75AADB", INK = "1A3A5E", MUT = "6E8CAB", BG = "F4F9FD", GREEN = "157A5B";
const hex = (c: string) => c.replace("#", "");

function chartData(slices: ChartSlice[]) {
  return [{ name: "", labels: slices.map((s) => s.label), values: slices.map((s) => s.value) }];
}
const chartColors = (slices: ChartSlice[]) => slices.map((s) => hex(s.color));

export async function exportCierrePptx(model: CierreModel): Promise<void> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const p = new PptxGenJS();
  p.defineLayout({ name: "W", width: 13.33, height: 7.5 });
  p.layout = "W";

  // 1. Portada (fondo celeste).
  const s1 = p.addSlide(); s1.background = { color: CEL };
  s1.addShape(p.ShapeType.rect, { x: 0.9, y: 2.4, w: 0.12, h: 1.5, fill: { color: "FFFFFF" } });
  s1.addText(`EERR · ${model.portada.localNombre}`, { x: 0.9, y: 3.9, w: 11.5, h: 1, fontSize: 40, bold: true, color: "FFFFFF", fontFace: "Inter" });
  s1.addText(model.portada.mesLabel, { x: 0.92, y: 4.9, w: 11.5, h: 0.6, fontSize: 22, color: "FFFFFF", fontFace: "Inter" });

  const titulo = (s: ReturnType<typeof p.addSlide>, t: string, sub?: string) => {
    s.background = { color: BG };
    s.addText(t, { x: 0.6, y: 0.45, w: 12, h: 0.7, fontSize: 26, bold: true, color: INK, fontFace: "Inter" });
    if (sub) s.addText(sub, { x: 0.62, y: 1.15, w: 12, h: 0.4, fontSize: 13, color: MUT, fontFace: "Inter" });
    s.addShape(p.ShapeType.rect, { x: 0.62, y: 1.05, w: 0.6, h: 0.05, fill: { color: CEL } });
  };
  const tablaMontos = (items: { label: string; valueFmt: string }[]) =>
    items.map((x) => [{ text: x.label, options: { fontSize: 12, color: INK } }, { text: x.valueFmt, options: { fontSize: 12, color: INK, align: "right" as const } }]);

  // 2. Ingresos (pie nativo).
  const s2 = p.addSlide(); titulo(s2, "Ingresos");
  s2.addText(model.ingresos.totalFmt, { x: 0.6, y: 1.5, w: 6, h: 0.7, fontSize: 32, bold: true, color: INK, fontFace: "Inter" });
  if (model.ingresos.prevFmt) s2.addText(`${model.ingresos.prevLabel}: ${model.ingresos.prevFmt}`, { x: 0.62, y: 2.2, w: 6, h: 0.4, fontSize: 13, color: CEL });
  s2.addTable(tablaMontos(model.ingresos.items), { x: 0.6, y: 2.7, w: 6, fontFace: "Inter", border: { type: "solid", color: "E9EAEE", pt: 0.5 } });
  s2.addChart(p.ChartType.pie, chartData(model.ingresos.chart), { x: 7.1, y: 1.6, w: 5.6, h: 5.2, chartColors: chartColors(model.ingresos.chart), showLegend: true, legendPos: "r", showPercent: true, dataLabelФontFace: "Inter" } as never);

  // 3. CMV (doughnut nativo).
  const s3 = p.addSlide(); titulo(s3, "Egresos · Costo de mercadería (CMV)", `${model.cmv.pctVentas} sobre ventas` + (model.cmv.prevPct ? `  ·  ${model.ingresos.prevLabel}: ${model.cmv.prevPct}` : ""));
  s3.addTable(tablaMontos(model.cmv.items), { x: 0.6, y: 1.6, w: 6, fontFace: "Inter", border: { type: "solid", color: "E9EAEE", pt: 0.5 } });
  s3.addText(`Utilidad bruta: ${model.cmv.utilBrutaPct}`, { x: 0.6, y: 6.6, w: 6, h: 0.4, fontSize: 14, color: CEL });
  s3.addChart(p.ChartType.doughnut, chartData(model.cmv.chart), { x: 7.1, y: 1.5, w: 5.6, h: 5.4, chartColors: chartColors(model.cmv.chart), showLegend: true, legendPos: "r", showPercent: true, holeSize: 55 } as never);

  // 4. Gastos fijos y varios (doughnut).
  const s4 = p.addSlide(); titulo(s4, "Egresos · Gastos fijos y varios", `${model.gastos.pctVentas} sobre ventas` + (model.gastos.prevPct ? `  ·  ${model.ingresos.prevLabel}: ${model.gastos.prevPct}` : ""));
  s4.addTable(tablaMontos(model.gastos.items), { x: 0.6, y: 1.6, w: 6, fontFace: "Inter", border: { type: "solid", color: "E9EAEE", pt: 0.5 } });
  s4.addChart(p.ChartType.doughnut, chartData(model.gastos.chart), { x: 7.1, y: 1.5, w: 5.6, h: 5.4, chartColors: chartColors(model.gastos.chart), showLegend: true, legendPos: "r", showPercent: true, holeSize: 55 } as never);

  // 5. Resumen.
  const s5 = p.addSlide(); titulo(s5, "Egresos · Resumen");
  const filas = model.resumen.lines.map((l) => [{ text: `${l.label}: ${l.pct}`, options: { fontSize: 16, color: INK } }, { text: l.montoFmt, options: { fontSize: 16, color: INK, align: "right" as const } }]);
  s5.addTable(filas, { x: 1, y: 2, w: 11.3, fontFace: "Inter", rowH: 0.6 });
  s5.addText([{ text: "Total de gastos:  ", options: { color: INK } }, { text: model.resumen.totalGastosFmt, options: { color: INK } }], { x: 1, y: 5, w: 11.3, fontSize: 19, bold: true, fontFace: "Inter" });
  s5.addText([{ text: `Rentabilidad final: ${model.resumen.rentabilidadPct}  `, options: { color: GREEN } }, { text: model.resumen.rentabilidadFmt, options: { color: GREEN } }], { x: 1, y: 5.7, w: 11.3, fontSize: 22, bold: true, fontFace: "Inter" });

  // 6. División (si hay).
  if (model.division) {
    const s6 = p.addSlide(); titulo(s6, "División de ganancias");
    s6.addText(`Rentabilidad: ${model.division.rentabilidadFmt}`, { x: 0.6, y: 1.5, w: 11, h: 0.5, fontSize: 17, color: GREEN, fontFace: "Inter" });
    const dfilas = model.division.items.map((d) => [{ text: `${d.nombre}  (${d.pct})`, options: { fontSize: 18, color: INK } }, { text: d.montoFmt, options: { fontSize: 18, color: INK, align: "right" as const } }]);
    s6.addTable(dfilas, { x: 1, y: 2.4, w: 8, fontFace: "Inter", rowH: 0.55 });
    s6.addText("Nota: editá este texto con la propuesta de reparto (ej: 70% Neko / 30% socios).", { x: 1, y: 6.4, w: 11, h: 0.5, fontSize: 11, italic: true, color: MUT, fontFace: "Inter" });
  }

  await p.writeFile({ fileName: `Cierre_${model.portada.localNombre.replace(/[^\w]+/g, "-")}_${model.portada.mesLabel.replace(/\s/g, "-")}.pptx` });
}
```

> Nota impl: PptxGenJS tipa algunas options de chart de forma estricta; el `as never` en `addChart` evita fricción de tipos. Verificar la prop exacta de fuente de data labels (`dataLabelFontFace`) y corregir el typo del ejemplo. Si `defineLayout`/`layout` da fricción de tipos, usar `p.defineLayout` + `p.layout = "W"` como está, o el layout default `LAYOUT_WIDE`.

- [ ] **Step 3: typecheck** — `pnpm --filter pase typecheck`. Resolver fricciones de tipos de pptxgenjs (usar `as never`/`as PptxGenJS.*` donde haga falta). 
- [ ] **Step 4: Commit**

```bash
git add packages/pase/src/lib/cierre/cierrePptx.ts packages/pase/package.json pnpm-lock.yaml
git commit -m "feat(cierre): renderer PPTX editable con charts nativos"
```

---

## Task 5: Wirear el menú Exportar en `EERR.tsx`

**Files:** Modify `src/pages/EERR.tsx`

Hoy el botón Exportar (un solo `<button>`) llama `exportEERRPdf`. Lo convertimos en **menú** de 3 opciones. Necesitamos: nombre del local (ya se trae), `cargarMesResumen(prevMes)` para el mes anterior, y los socios del local.

- [ ] **Step 1: Agregar estado del menú** — junto a `const [exportando,setExportando]=useState(false);`:

```tsx
  const [menuExport,setMenuExport]=useState(false);
```

- [ ] **Step 2: Helper para juntar el input del cierre** — agregar dentro del componente (antes del `return`), reutilizando `cargarMesResumen` y las variables ya calculadas (`porMedio`, `porCatCMV`, `porCatFijos`, `porCatVar`, totales):

```tsx
  const prevMesDe = (m: string): string => {
    const [yr, mo] = m.split("-").map(Number);
    const d = new Date((yr ?? 2026), (mo ?? 1) - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  const armarCierreInput = async () => {
    let localNombre = "Todos los locales";
    if (localActivo != null) {
      const { data: loc } = await db.from("locales").select("nombre").eq("id", localActivo).maybeSingle();
      if (loc?.nombre) localNombre = loc.nombre as string;
    }
    const pmes = prevMesDe(mes);
    const prevRes = await cargarMesResumen(pmes).catch(() => null);
    let socios: { nombre: string; porcentaje: number }[] = [];
    if (localActivo != null) {
      const { data: ss } = await db.from("utilidades_socios").select("nombre, porcentaje, activo").eq("local_id", localActivo).eq("activo", true);
      socios = ((ss as { nombre: string; porcentaje: number }[]) || []).map(s => ({ nombre: s.nombre, porcentaje: Number(s.porcentaje) }));
    }
    return {
      localNombre, mes, emitido: new Date().toLocaleDateString("es-AR"),
      ventas: totalVentas, cmv: totalCMV, utilBruta, gastosFijosVar: totalGastos,
      sueldos, cargas: totalCargasSociales, boletas: totalBoletasSindicales,
      publicidad: totalPublicidad, comisiones: totalComisiones, impuestos: totalImpuestos, otros: totalOtrosGastos, utilNeta,
      porMedio: porMedio.map(x => ({ label: x.m, value: x.t })),
      cmvPorCat: porCatCMV.map(x => ({ label: x.c, value: x.t })),
      gastosPorCat: [...porCatFijos, ...porCatVar].map(x => ({ label: x.c, value: x.t })).sort((a, b) => b.value - a.value),
      prev: prevRes ? { ventas: prevRes.ventas, cmv: prevRes.cmv, gastosFijos: prevRes.gastosFijos, gastosVar: prevRes.gastosVar, publicidad: prevRes.publicidad, comisiones: prevRes.comisiones, impuestos: prevRes.impuestos, otrosGastos: prevRes.otrosGastos, sueldos: prevRes.sueldos, cargasSociales: prevRes.cargasSociales, utilNeta: prevRes.utilNeta } : null,
      prevMes: prevRes ? pmes : null,
      socios,
    };
  };

  const exportarCierre = async (formato: "pdf" | "pptx") => {
    setMenuExport(false); setExportando(true);
    try {
      const input = await armarCierreInput();
      const { assembleCierre } = await import("../lib/cierre/cierreData");
      const model = assembleCierre(input);
      if (formato === "pdf") (await import("../lib/cierre/cierrePdf")).exportCierrePdf(model);
      else await (await import("../lib/cierre/cierrePptx")).exportCierrePptx(model);
    } catch (e) {
      alert("No se pudo generar la presentación: " + (e instanceof Error ? e.message : String(e)));
    } finally { setExportando(false); }
  };
```

> **Confirmado (21-jun):** la tabla es **`utilidades_socios`** (`src/lib/utilidades.ts:50`) con `nombre`/`porcentaje`/`activo`; verificar solo que tenga `local_id` para el `.eq("local_id", ...)` (si el scoping fuera distinto, mirar cómo filtra `src/lib/utilidades.ts`). `cargarMesResumen(mes): Promise<MesResumen>` (`EERR.tsx:124`) devuelve los campos usados.

- [ ] **Step 3: Reemplazar el `<button>` Exportar por el menú** — el botón actual (el del `onClick` que llama `exportEERRPdf`) se envuelve en un contenedor con dropdown:

```tsx
          <div style={{ position: "relative", display: "inline-block" }}>
            <button type="button" className="btn btn-ghost btn-sm" disabled={exportando || loading}
              onClick={() => setMenuExport(o => !o)} style={{ fontSize: 11 }}>
              {exportando ? "Generando..." : "⬇ Exportar ▾"}
            </button>
            {menuExport && (
              <div style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", background: "#fff", border: "0.5px solid var(--pase-border-strong)", borderRadius: 8, boxShadow: "0 6px 18px rgba(20,23,31,.08)", zIndex: 20, minWidth: 230 }}>
                {[
                  { k: "resumen", t: "Resumen (1 hoja) · PDF" },
                  { k: "cierre-pdf", t: "Presentación de cierre · PDF" },
                  { k: "cierre-pptx", t: "Presentación de cierre · PowerPoint" },
                ].map(opt => (
                  <button key={opt.k} type="button" className="btn btn-ghost btn-sm" style={{ display: "block", width: "100%", textAlign: "left", fontSize: 12, borderRadius: 0 }}
                    onClick={() => {
                      if (opt.k === "resumen") { setMenuExport(false); exportarResumenUnaHoja(); }
                      else if (opt.k === "cierre-pdf") exportarCierre("pdf");
                      else exportarCierre("pptx");
                    }}>{opt.t}</button>
                ))}
              </div>
            )}
          </div>
```

Renombrar la lógica actual del PDF de 1 hoja a una función `exportarResumenUnaHoja()` (mover el cuerpo del `onClick` actual a esa función, que ya hace `setExportando` + `exportEERRPdf`).

- [ ] **Step 4: typecheck + lint** — `pnpm --filter pase typecheck && npx --prefix packages/pase eslint packages/pase/src/pages/EERR.tsx packages/pase/src/lib/cierre/`. Cero errores. (Cerrar el menú al clickear afuera es opcional; si se agrega, usar un `useEffect` con listener en `document` — YAGNI por ahora.)
- [ ] **Step 5: Commit**

```bash
git add packages/pase/src/pages/EERR.tsx
git commit -m "feat(cierre): menu Exportar con presentacion PDF/PPTX en Reportes"
```

---

## Task 6: Verificación visual + cierre

- [ ] **Step 1: Build** — `pnpm --filter pase build`. Verificar que `pptxgenjs` y los renderers quedan en **chunks aparte** (import dinámico) y que el build pasa.
- [ ] **Step 2: Render de muestra (PDF)** — transpilar/usar Node type-stripping para llamar `slidesHtml`/`assembleCierre` con el fixture de Rene mayo (como se hizo con `exportEERRPdf`: `node` requiere el `.ts`, escribe el HTML de las 6 slides, Playwright (chromium de comanda) saca screenshot de cada `.slide`). Revisar visualmente: portada celeste, torta de ingresos, donas de CMV/gastos, resumen, división. Ajustar tamaños/overflow si una slide se corta.
- [ ] **Step 3: Lint final + tests** — `pnpm --filter pase test -- src/lib/cierre/ && pnpm --filter pase lint`. Verde.
- [ ] **Step 4: Push + verificar deploy** — `git push`; confirmar deploy Vercel `state=READY` (no se agregan funciones serverless, no aplica límite de 12).
- [ ] **Step 5: Memoria** — actualizar `project_rene_cantina_reportes.md` (export de cierre PDF+PPTX shippeado, módulo `src/lib/cierre/`) + marcar el pendiente de smoke de Lucas en `project_tareas_manuales_pendientes.md` (probar "Presentación de cierre" PDF y PowerPoint en un par de locales, revisar charts y reparto a socios).

---

## Self-review (cobertura del spec)
- Menú Exportar 3 opciones ✅ (T5). Resumen 1 hoja se mantiene ✅ (T5).
- 6 slides con datos de PASE ✅ (T2 modelo, T3 PDF, T4 PPTX). Comparación mes anterior ✅ (T2 `prev`, T5 `cargarMesResumen`). División socios ✅ (T2/T5).
- Estética PASE + charts con color ✅ (T1 paleta, T3/T4).
- PDF terminado ✅ (T3) + PPTX editable con charts nativos ✅ (T4).
- Edge cases (ventas 0, sin socios, sin mes anterior, muchas categorías→"Otros") ✅ (T1/T2 + tests).
- Frontend puro, sin DB/migraciones; sin mutante (presentación) ✅.
- **Riesgos a resolver en ejecución (señalados):** (a) nombre real de la tabla de socios y firma de `cargarMesResumen` (T5); (b) fricciones de tipos de `pptxgenjs` (T4); (c) overflow de slides en el render (T6 ajusta).
