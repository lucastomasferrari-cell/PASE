# Simulador de escenarios en Reportes (EERR) — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un modo "Simular" en Reportes (EERR) que deja tocar las líneas del Estado de Resultados de un mes (en curso o anterior) y ver al instante el impacto en la Utilidad Neta y el margen — solo análisis, sin tocar datos ni guardar nada.

**Architecture:** Todo frontend. Una función pura `simularEERR()` (en `src/lib/`, con test unitario) recalcula el P&L aplicando ajustes por línea ($ o %). Un componente `EERRSimulador.tsx` (sub-vista de Reportes) toma la base que `EERR.tsx` ya computa, la muestra editable lado a lado (Real vs Simulado) y recalcula en vivo. `EERR.tsx` suma un toggle "Simular" y le pasa la base. Sin migración, sin RPC, sin tabla.

**Tech Stack:** React 19 + TypeScript estricto + Vite + vitest. Sin React Testing Library en `pase` → el test automatizado va sobre la función pura; el componente/wiring se verifican con typecheck + lint + build + dev server.

**Spec:** `docs/superpowers/specs/2026-06-16-simulador-escenarios-eerr-design.md` (leer antes de empezar).

**Reglas del repo:** TS estricto (`noUncheckedIndexedAccess`), comunicación en español, push directo a `main`. NO lleva test mutante ni e2e-full (es solo lectura/análisis, no mueve plata — acordado con Lucas en la spec). Ojo: `Layout.tsx` y `Compras.tsx` pueden tener cambios sin commitear de otra sesión — al commitear, agregar SOLO los archivos de cada task con `git add <ruta>` explícito, nunca `git add -A`.

---

## File Structure

- **Create** `packages/pase/src/lib/eerrSimulador.ts` — tipos `LineasEERR`, `AjusteLinea`, `ResultadoEERR` + funciones puras `aplicarAjuste` y `simularEERR`. Única pieza con lógica. Sin dependencias del resto del código.
- **Create** `packages/pase/src/lib/eerrSimulador.test.ts` — test unitario vitest de la función pura.
- **Create** `packages/pase/src/pages/EERRSimulador.tsx` — componente UI del simulador. Recibe la base por props, no hace fetch.
- **Modify** `packages/pase/src/pages/EERR.tsx` — toggle "Simular escenario" + mapeo de la base + render condicional del componente.

---

## FASE 1 — Lógica pura (TDD)

### Task 1: Función `simularEERR` + test

**Files:**
- Create: `packages/pase/src/lib/eerrSimulador.ts`
- Test: `packages/pase/src/lib/eerrSimulador.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// packages/pase/src/lib/eerrSimulador.test.ts
import { describe, it, expect } from "vitest";
import { simularEERR, aplicarAjuste, type LineasEERR } from "./eerrSimulador";

const BASE: LineasEERR = {
  ventas: 1_000_000, cmv: 350_000,
  gastosFijos: 100_000, gastosVar: 50_000, sueldos: 200_000,
  cargasSociales: 60_000, publicidad: 20_000, comisiones: 30_000,
  impuestos: 40_000, otrosGastos: 10_000,
};
// gastos op = 510_000 ; utilBruta = 650_000 ; utilNeta = 140_000 ; margen 14%

describe("aplicarAjuste", () => {
  it("sin ajuste devuelve la base", () => expect(aplicarAjuste(100, undefined)).toBe(100));
  it("abs reemplaza el valor", () => expect(aplicarAjuste(100, { tipo: "abs", valor: 250 })).toBe(250));
  it("pct ajusta relativo (-10% => 90)", () => expect(aplicarAjuste(100, { tipo: "pct", valor: -10 })).toBe(90));
});

describe("simularEERR", () => {
  it("sin ajustes reproduce el EERR base", () => {
    const r = simularEERR(BASE, {});
    expect(r.utilBruta).toBe(650_000);
    expect(r.utilNeta).toBe(140_000);
    expect(r.margenNeto).toBeCloseTo(0.14, 5);
  });

  it("ajuste abs en CMV recalcula utilidades", () => {
    const r = simularEERR(BASE, { cmv: { tipo: "abs", valor: 300_000 } });
    expect(r.utilBruta).toBe(700_000);
    expect(r.utilNeta).toBe(190_000);
  });

  it("subir ventas sin tocar CMV: sube utilidad y margen, baja el CMV%", () => {
    const r = simularEERR(BASE, { ventas: { tipo: "pct", valor: 20 } });
    expect(r.lineas.ventas).toBe(1_200_000);
    expect(r.lineas.cmv).toBe(350_000); // CMV en $ NO cambió
    expect(r.utilNeta).toBeGreaterThan(140_000);
    expect(r.margenNeto).toBeGreaterThan(0.14);
    expect(r.lineas.cmv / r.lineas.ventas).toBeLessThan(BASE.cmv / BASE.ventas);
  });

  it("ventas en 0 → margen 0 (sin división por cero)", () => {
    const r = simularEERR({ ...BASE, ventas: 0 }, {});
    expect(r.margenNeto).toBe(0);
  });

  it("no muta el objeto base", () => {
    const snap = JSON.parse(JSON.stringify(BASE));
    simularEERR(BASE, { ventas: { tipo: "pct", valor: 50 } });
    expect(BASE).toEqual(snap);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `pnpm --filter pase test -- src/lib/eerrSimulador.test.ts`
Expected: FAIL — `Failed to resolve import "./eerrSimulador"` (el módulo no existe todavía).

- [ ] **Step 3: Escribir la implementación mínima**

```ts
// packages/pase/src/lib/eerrSimulador.ts
// Simulador de escenarios del EERR — función pura, sin estado ni I/O.
// Recalcula el Estado de Resultados aplicando ajustes por línea ($ o %).
// Las líneas son independientes: cambiar una NO escala a las otras (decisión
// de producto, Lucas 16-jun). Ver spec 2026-06-16-simulador-escenarios-eerr-design.md.

export interface LineasEERR {
  ventas: number;
  cmv: number;
  gastosFijos: number;
  gastosVar: number;
  sueldos: number;
  cargasSociales: number;   // incluye boletas sindicales (igual que MesResumen del EERR)
  publicidad: number;
  comisiones: number;
  impuestos: number;
  otrosGastos: number;
}

export type AjusteLinea =
  | { tipo: "abs"; valor: number }   // nuevo monto absoluto en $
  | { tipo: "pct"; valor: number };  // ajuste relativo en % (ej. -10 = bajar 10%)

export interface ResultadoEERR {
  lineas: LineasEERR;   // los montos resultantes tras aplicar los ajustes
  utilBruta: number;    // ventas - cmv
  utilNeta: number;     // utilBruta - gastos operativos
  margenNeto: number;   // utilNeta / ventas (0 si ventas <= 0)
}

const KEYS_GASTO: (keyof LineasEERR)[] = [
  "gastosFijos", "gastosVar", "sueldos", "cargasSociales",
  "publicidad", "comisiones", "impuestos", "otrosGastos",
];

/** Aplica un ajuste a un valor base. Sin ajuste → devuelve la base. */
export function aplicarAjuste(base: number, ajuste: AjusteLinea | undefined): number {
  if (!ajuste) return base;
  if (ajuste.tipo === "abs") return ajuste.valor;
  return base * (1 + ajuste.valor / 100);
}

/** Recalcula el EERR aplicando los ajustes por línea. Función pura. */
export function simularEERR(
  base: LineasEERR,
  ajustes: Partial<Record<keyof LineasEERR, AjusteLinea>>,
): ResultadoEERR {
  const lineas = {} as LineasEERR;
  (Object.keys(base) as (keyof LineasEERR)[]).forEach((k) => {
    lineas[k] = aplicarAjuste(base[k], ajustes[k]);
  });
  const utilBruta = lineas.ventas - lineas.cmv;
  const gastosOperativos = KEYS_GASTO.reduce((s, k) => s + lineas[k], 0);
  const utilNeta = utilBruta - gastosOperativos;
  const margenNeto = lineas.ventas > 0 ? utilNeta / lineas.ventas : 0;
  return { lineas, utilBruta, utilNeta, margenNeto };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `pnpm --filter pase test -- src/lib/eerrSimulador.test.ts`
Expected: PASS (todos los `it`).

- [ ] **Step 5: Commit**

```bash
git add packages/pase/src/lib/eerrSimulador.ts packages/pase/src/lib/eerrSimulador.test.ts
git commit -m "feat(simulador): funcion pura simularEERR + test"
```

---

## FASE 2 — Componente UI

### Task 2: Componente `EERRSimulador.tsx`

**Files:**
- Create: `packages/pase/src/pages/EERRSimulador.tsx`

- [ ] **Step 1: Escribir el componente**

```tsx
// packages/pase/src/pages/EERRSimulador.tsx
// Simulador de escenarios del EERR (sub-vista de Reportes). Recibe la base ya
// computada por EERR.tsx, deja editar cada línea ($ o %) y muestra Real vs
// Simulado en vivo. NO hace fetch, NO escribe nada, NO guarda. La matemática
// vive en lib/eerrSimulador.ts.
import { Fragment, useMemo, useState } from "react";
import { fmt_$ } from "../lib/utils";
import { simularEERR, type LineasEERR, type AjusteLinea } from "../lib/eerrSimulador";

interface Props {
  base: LineasEERR;
  mes: string;            // "YYYY-MM"
  onClose: () => void;
}

type Unidad = "abs" | "pct";
interface InputLinea { unidad: Unidad; texto: string }

const LINEAS: { key: keyof LineasEERR; label: string }[] = [
  { key: "ventas", label: "Ventas Brutas" },
  { key: "cmv", label: "Compras de mercadería" },
  { key: "gastosFijos", label: "Gastos Fijos" },
  { key: "gastosVar", label: "Gastos Variables" },
  { key: "sueldos", label: "Sueldos" },
  { key: "cargasSociales", label: "Cargas Sociales" },
  { key: "publicidad", label: "Publicidad y MKT" },
  { key: "comisiones", label: "Comisiones" },
  { key: "impuestos", label: "Impuestos" },
  { key: "otrosGastos", label: "Otros Gastos" },
];

const pctTxt = (n: number, ventas: number) => (ventas > 0 ? ((n / ventas) * 100).toFixed(1) + "%" : "—");

export default function EERRSimulador({ base, mes, onClose }: Props) {
  const [inputs, setInputs] = useState<Partial<Record<keyof LineasEERR, InputLinea>>>({});

  const ajustes = useMemo(() => {
    const out: Partial<Record<keyof LineasEERR, AjusteLinea>> = {};
    (Object.keys(inputs) as (keyof LineasEERR)[]).forEach((k) => {
      const inp = inputs[k];
      if (!inp || inp.texto.trim() === "") return;
      const valor = Number(inp.texto);
      if (Number.isNaN(valor)) return;
      out[k] = { tipo: inp.unidad, valor };
    });
    return out;
  }, [inputs]);

  const real = useMemo(() => simularEERR(base, {}), [base]);
  const sim = useMemo(() => simularEERR(base, ajustes), [base, ajustes]);
  const deltaNeta = sim.utilNeta - real.utilNeta;

  const setLinea = (k: keyof LineasEERR, patch: Partial<InputLinea>) =>
    setInputs((prev) => ({
      ...prev,
      [k]: { unidad: prev[k]?.unidad ?? "pct", texto: prev[k]?.texto ?? "", ...patch },
    }));

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontWeight: 600 }}>Simulador de escenario · {mes}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setInputs({})}>Reset</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Salir del simulador</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
        <Kpi label="Utilidad Neta — Real" value={fmt_$(real.utilNeta)} sub={pctTxt(real.utilNeta, real.lineas.ventas)} />
        <Kpi label="Utilidad Neta — Simulada" value={fmt_$(sim.utilNeta)} sub={pctTxt(sim.utilNeta, sim.lineas.ventas)}
          color={sim.utilNeta >= real.utilNeta ? "var(--pase-celeste)" : "#B91C1C"} />
        <Kpi label="Diferencia" value={(deltaNeta >= 0 ? "+" : "") + fmt_$(deltaNeta)}
          color={deltaNeta >= 0 ? "var(--pase-celeste)" : "#B91C1C"} />
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ color: "var(--pase-text-muted)", fontSize: 11, textAlign: "left" }}>
              <th style={th}>Línea</th>
              <th style={{ ...th, textAlign: "right" }}>Real</th>
              <th style={{ ...th, textAlign: "center" }}>Ajuste</th>
              <th style={{ ...th, textAlign: "right" }}>Simulado</th>
            </tr>
          </thead>
          <tbody>
            {LINEAS.map(({ key, label }) => {
              const inp = inputs[key];
              const realV = real.lineas[key];
              const simV = sim.lineas[key];
              return (
                <Fragment key={key}>
                  <tr style={{ borderTop: "0.5px solid var(--pase-border)" }}>
                    <td style={td}>{label}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {fmt_$(realV)} <span style={muted}>{pctTxt(realV, real.lineas.ventas)}</span>
                    </td>
                    <td style={{ ...td, textAlign: "center", whiteSpace: "nowrap" }}>
                      <select value={inp?.unidad ?? "pct"} onChange={(e) => setLinea(key, { unidad: e.target.value as Unidad })} style={sel}>
                        <option value="pct">%</option>
                        <option value="abs">$</option>
                      </select>
                      <input value={inp?.texto ?? ""} onChange={(e) => setLinea(key, { texto: e.target.value })}
                        inputMode="decimal" placeholder={(inp?.unidad ?? "pct") === "abs" ? "$ nuevo" : "% ej. -10"}
                        style={inputStyle} />
                    </td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: simV !== realV ? 600 : 400 }}>
                      {fmt_$(simV)} <span style={muted}>{pctTxt(simV, sim.lineas.ventas)}</span>
                    </td>
                  </tr>
                  {key === "cmv" && (
                    <SubtotalRow label="Utilidad Bruta" real={real.utilBruta} sim={sim.utilBruta}
                      ventasReal={real.lineas.ventas} ventasSim={sim.lineas.ventas} />
                  )}
                </Fragment>
              );
            })}
            <SubtotalRow label="Utilidad Neta" real={real.utilNeta} sim={sim.utilNeta}
              ventasReal={real.lineas.ventas} ventasSim={sim.lineas.ventas} big />
          </tbody>
        </table>
      </div>

      <div style={{ ...muted, marginTop: 10 }}>
        Simulación en vivo — no modifica ningún dato real ni se guarda. El ajuste en % es relativo al valor real
        (ej. −10 baja un 10%); en $ reemplaza el monto. Las líneas son independientes.
      </div>
    </div>
  );
}

function SubtotalRow({ label, real, sim, ventasReal, ventasSim, big }: {
  label: string; real: number; sim: number; ventasReal: number; ventasSim: number; big?: boolean;
}) {
  return (
    <tr style={{ borderTop: big ? "1.5px solid var(--pase-border)" : "1px solid var(--pase-border)", fontWeight: 600 }}>
      <td style={td}>{label}</td>
      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmt_$(real)} <span style={muted}>{pctTxt(real, ventasReal)}</span></td>
      <td style={td}></td>
      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", color: sim >= real ? "var(--pase-celeste)" : "#B91C1C" }}>{fmt_$(sim)} <span style={muted}>{pctTxt(sim, ventasSim)}</span></td>
    </tr>
  );
}

function Kpi({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ minWidth: 160 }}>
      <div style={{ fontSize: 11, color: "var(--pase-text-muted)" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: color ?? "var(--pase-text)" }}>{value}</div>
      {sub && <div style={muted}>{sub}</div>}
    </div>
  );
}

const card: React.CSSProperties = { border: "0.5px solid var(--pase-border)", borderRadius: 10, padding: 16, background: "var(--pase-surface)", marginTop: 12 };
const th: React.CSSProperties = { padding: "4px 8px", fontWeight: 400 };
const td: React.CSSProperties = { padding: "5px 8px" };
const muted: React.CSSProperties = { fontSize: 10, color: "var(--pase-text-muted)" };
const sel: React.CSSProperties = { padding: "2px 4px", borderRadius: 6, border: "0.5px solid var(--pase-border)", background: "var(--pase-surface)", color: "var(--pase-text)", marginRight: 4 };
const inputStyle: React.CSSProperties = { padding: "3px 6px", borderRadius: 6, border: "0.5px solid var(--pase-border)", background: "var(--pase-surface)", color: "var(--pase-text)", textAlign: "right", width: 100 };
```

- [ ] **Step 2: Verificar que typecheck pasa**

Run: `pnpm --filter pase typecheck`
Expected: sin errores (sale limpio).

- [ ] **Step 3: Commit**

```bash
git add packages/pase/src/pages/EERRSimulador.tsx
git commit -m "feat(simulador): componente EERRSimulador (Real vs Simulado en vivo)"
```

---

## FASE 3 — Wiring en Reportes

### Task 3: Toggle "Simular" + base en `EERR.tsx`

**Files:**
- Modify: `packages/pase/src/pages/EERR.tsx`

- [ ] **Step 1: Importar el componente y el tipo**

En el bloque de imports de `EERR.tsx` (arriba, junto a los otros `import`), agregar:

```tsx
import EERRSimulador from "./EERRSimulador";
import type { LineasEERR } from "../lib/eerrSimulador";
```

- [ ] **Step 2: Estado del toggle**

Dentro del componente `EERR` (donde están los otros `useState`, ej. cerca de `const [mes, setMes] = useState(...)`), agregar:

```tsx
const [simulando, setSimulando] = useState(false);
```

- [ ] **Step 3: Mapear la base del simulador**

Justo DESPUÉS de la definición de `resumenPrincipal` (busca `const resumenPrincipal: MesResumen = {` y su cierre `};`, ~línea 372), agregar el mapeo a `LineasEERR` (mismas cifras que el EERR; `cargasSociales` incluye boletas sindicales, igual que `resumenPrincipal`):

```tsx
const baseSimulador: LineasEERR = {
  ventas: totalVentas,
  cmv: totalCMV,
  gastosFijos: totalGastosFijos,
  gastosVar: totalGastosVar,
  sueldos,
  cargasSociales: totalCargasSociales + totalBoletasSindicales,
  publicidad: totalPublicidad,
  comisiones: totalComisiones,
  impuestos: totalImpuestos,
  otrosGastos: totalOtrosGastos,
};
```

- [ ] **Step 4: Botón "Simular escenario" en la barra de acciones**

En el header de acciones (busca el `<button>` del export CSV que arranca con `className="btn btn-ghost btn-sm"` y el comentario `// Export del Resumen P&L`, ~línea 465). Agregar ANTES de ese botón de export:

```tsx
<button type="button" className="btn btn-ghost btn-sm" style={{fontSize:11}}
  onClick={() => setSimulando(s => !s)}>
  {simulando ? "Cerrar simulador" : "Simular escenario"}
</button>
```

- [ ] **Step 5: Render condicional del simulador**

Buscar el cierre de la card del Resumen P&L (la sección que renderiza las filas del Estado de Resultados con los `ERow` / la tabla del P&L, dentro del `return`). Inmediatamente DESPUÉS de esa card, agregar:

```tsx
{simulando && (
  <EERRSimulador base={baseSimulador} mes={mes} onClose={() => setSimulando(false)} />
)}
```

- [ ] **Step 6: Verificar typecheck + lint + build**

Run: `pnpm --filter pase typecheck`
Expected: sin errores.

Run: `npx eslint src/pages/EERR.tsx src/pages/EERRSimulador.tsx src/lib/eerrSimulador.ts` (desde `packages/pase`)
Expected: 0 errores (warnings pre-existentes de EERR.tsx que no sean de estas líneas se ignoran; los archivos nuevos deben dar 0).

Run: `pnpm --filter pase build`
Expected: `✓ built`.

- [ ] **Step 7: Smoke manual (dev server)**

Run: `pnpm --filter pase dev` → abrir `http://localhost:5173` → login → Reportes → elegir un mes con datos → "Simular escenario". Verificar: aparece la tabla Real vs Simulado; cambiar Ventas a "+20%" sube Utilidad Neta y margen; cambiar CMV en "$" lo reemplaza; "Reset" limpia; "Cerrar simulador" lo oculta. Nada cambia en el reporte real.

- [ ] **Step 8: Commit**

```bash
git add packages/pase/src/pages/EERR.tsx
git commit -m "feat(simulador): toggle Simular en Reportes + base del EERR"
```

---

## FASE 4 — Cierre

### Task 4: Verificación final + memoria
- [ ] **Step 1:** `pnpm --filter pase test -- src/lib/eerrSimulador.test.ts` (verde) + `pnpm --filter pase typecheck` + `build` OK.
- [ ] **Step 2:** Push a `main` y verificar deploy Vercel `state=READY` (`npx vercel ls`).
- [ ] **Step 3:** Actualizar memoria: nota en `project_pase_*` (simulador de escenarios en Reportes construido) + recordar que el sub-proyecto siguiente es **Cierre/bloqueo de mes**. Actualizar `MEMORY.md` si se crea archivo nuevo.

---

## Self-review notes
- **Cobertura de la spec:** nivel línea EERR ✅ (Task 1/2), $ o % ✅ (AjusteLinea + selector), líneas independientes ✅ (sin escalado), en vivo sin persistencia ✅ (solo estado local), Real vs Simulado + delta ✅ (Task 2), vive en Reportes ✅ (Task 3), sin backend ✅, test unitario ✅ (Task 1), sin mutante/e2e-full ✅ (documentado). Fuera de alcance (foto/bloqueo) = sub-proyecto siguiente.
- **Consistencia de tipos:** `LineasEERR` (10 keys) se define en Task 1 y se reusa idéntico en Task 2 y Task 3; `cargasSociales` incluye boletas sindicales en los 3 lugares. `AjusteLinea` (abs/pct) consistente. `simularEERR(base, ajustes) → ResultadoEERR{lineas, utilBruta, utilNeta, margenNeto}` usado igual en el componente.
- **Placeholders:** ninguno — todo el código está completo. Los únicos pasos "por anclaje" son las inserciones en `EERR.tsx` (archivo de ~1000 líneas), con el texto exacto a buscar indicado.
