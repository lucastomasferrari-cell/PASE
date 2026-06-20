# Conciliación — Pieza 3: ignorar transferencias devueltas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el cruce de conciliación ignore las transferencias que se enviaron y se devolvieron dentro del mismo extracto (envío + devolución, mismo `referencia_externa`, montos opuestos → neto cero), en vez de tratarlas como un egreso real que roba matches.

**Architecture:** El extracto subido (parseado a `ExtractoMovimiento[]`) ya contiene tanto egresos (monto < 0) como ingresos/devoluciones (monto > 0). Hoy el frontend manda al cruce SOLO los egresos (`egresosExtracto`). Agregamos una función pura `refsDevueltas(movs)` que detecta los pares envío+devolución y devuelve el set de `referencia_externa` neteadas. El frontend excluye esos egresos del payload que manda al cruce y los muestra aparte como "devueltas — ignoradas". **No se toca SQL** — el cruce (`fn_cruzar_extracto_mp`) queda intacto; solo cambia qué egresos recibe.

**Tech Stack:** React 19 + TypeScript estricto (`strict`, `noUncheckedIndexedAccess`), Vite, vitest 4 (unit). Sin cambios de DB.

---

## Contexto del problema (caso real Sorribas, 18-jun)

Una transferencia a "Jorge Alberto Sorribas" se mandó por $119.569,54 y **volvió** (devolución MP, mismo `referencia_externa` 158658195423, signo opuesto). Como el cruce solo ve egresos, la trató como pago real y la matcheó por monto contra una factura de SAN JOSE — robándole el match a la transferencia real de SAN JOSE, que quedó como "falta". Al netear y sacarla del pool, el match correcto queda libre.

## File Structure

- `packages/pase/src/lib/conciliacionDevueltas.ts` (CREATE) — función pura `refsDevueltas(movs)`. Una responsabilidad: detectar refs neteadas. Sin React, sin I/O → testeable en aislamiento.
- `packages/pase/src/lib/conciliacionDevueltas.test.ts` (CREATE) — unit tests vitest de la función pura.
- `packages/pase/src/pages/ConciliacionExtracto.tsx` (MODIFY) — importar y usar la función: excluir devueltas del payload, mostrarlas aparte.

## Notas de cumplimiento (CLAUDE.md)

- **C2 (test mutante):** NO aplica. Este cambio es frontend-only y de **solo lectura** — no mueve plata, no agrega/cambia RPC. El cruce calcula matches; la plata se mueve recién al aplicar/cerrar (fuera de scope). Cobertura = unit test de la función pura + verificación reproduciendo el cruce real desde el borrador guardado.
- **E2E full:** NO se agrega operación nueva (no hay flow de plata nuevo). El cruce de conciliación no está en el script del "mes operativo". Si al revisar resulta que sí conviene un invariante, plantearlo a Lucas — no bloquear el merge por esto.
- **Verificación antes/después obligatoria** (zona de plata, función ya parchada varias veces el 18-jun): reproducir el cruce desde `conciliacion_borradores` (Rene Cantina, mayo) y confirmar que la transferencia Sorribas pasa de "matcheada/falta cruzada" a "devuelta — ignorada" y que la de SAN JOSE recupera su match. Esto se hace en la Task 4 ANTES de dar por cerrado.

---

### Task 1: Función pura `refsDevueltas`

**Files:**
- Create: `packages/pase/src/lib/conciliacionDevueltas.ts`
- Test: `packages/pase/src/lib/conciliacionDevueltas.test.ts`

- [ ] **Step 1: Write the failing test**

Crear `packages/pase/src/lib/conciliacionDevueltas.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter pase test -- src/lib/conciliacionDevueltas.test.ts`
Expected: FAIL — "Failed to resolve import './conciliacionDevueltas'" o "refsDevueltas is not a function".

- [ ] **Step 3: Write minimal implementation**

Crear `packages/pase/src/lib/conciliacionDevueltas.ts`:

```ts
import type { ExtractoMovimiento } from "./mpExtractoParser";

/**
 * Detecta transferencias que se enviaron Y se devolvieron dentro del mismo
 * extracto: un egreso (monto < 0) y una devolución (monto > 0) con el mismo
 * `referencia_externa` y el mismo monto absoluto. Netean cero → no son un pago
 * real y no deben entrar al cruce.
 *
 * Devuelve el set de `referencia_externa` neteadas. El egreso con esa ref se
 * saca del pool de matching; se muestra aparte como "devuelta — ignorada".
 *
 * Tolerancia de $1 para absorber redondeos de centavos del extracto.
 */
export function refsDevueltas(movs: ExtractoMovimiento[]): Set<string> {
  const egresoPorRef = new Map<string, number>();
  for (const m of movs) {
    if (m.monto < 0 && m.referencia_externa) {
      egresoPorRef.set(m.referencia_externa, Math.abs(m.monto));
    }
  }
  const refs = new Set<string>();
  for (const m of movs) {
    if (m.monto > 0 && m.referencia_externa) {
      const montoEgreso = egresoPorRef.get(m.referencia_externa);
      if (montoEgreso != null && Math.abs(montoEgreso - m.monto) < 1) {
        refs.add(m.referencia_externa);
      }
    }
  }
  return refs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter pase test -- src/lib/conciliacionDevueltas.test.ts`
Expected: PASS — 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/pase/src/lib/conciliacionDevueltas.ts packages/pase/src/lib/conciliacionDevueltas.test.ts
git commit -m "feat(conciliacion): helper refsDevueltas para detectar transferencias devueltas (Pieza 3)"
```

---

### Task 2: Excluir devueltas del payload del cruce

**Files:**
- Modify: `packages/pase/src/pages/ConciliacionExtracto.tsx` (import nuevo + memo `devueltasRefs` + cambio de `egresosExtracto`)

- [ ] **Step 1: Agregar el import**

En `packages/pase/src/pages/ConciliacionExtracto.tsx`, junto a los otros imports de `../lib/` (cerca de `import { ..., type ExtractoMovimiento } from ".../mpExtractoParser"` — línea ~15), agregar:

```ts
import { refsDevueltas } from "../lib/conciliacionDevueltas";
```

- [ ] **Step 2: Agregar el memo `devueltasRefs` y excluir del egresosExtracto**

Reemplazar el `useMemo` de `egresosExtracto` (actualmente líneas ~461-463):

```ts
  const egresosExtracto = useMemo(
    () => extractoMovs.filter(m => m.monto < 0),
    [extractoMovs],
  );
```

por:

```ts
  const devueltasRefs = useMemo(() => refsDevueltas(extractoMovs), [extractoMovs]);
  const egresosExtracto = useMemo(
    () => extractoMovs.filter(
      m => m.monto < 0 && !(m.referencia_externa != null && devueltasRefs.has(m.referencia_externa)),
    ),
    [extractoMovs, devueltasRefs],
  );
  const egresosDevueltos = useMemo(
    () => extractoMovs.filter(
      m => m.monto < 0 && m.referencia_externa != null && devueltasRefs.has(m.referencia_externa),
    ),
    [extractoMovs, devueltasRefs],
  );
  const ingresosReales = useMemo(
    () => extractoMovs.filter(
      m => m.monto > 0 && !(m.referencia_externa != null && devueltasRefs.has(m.referencia_externa)),
    ),
    [extractoMovs, devueltasRefs],
  );
```

(`cruzar()` y `refrescarCruce()` ya construyen su payload con `egresosExtracto.map(...)` — al excluir las devueltas acá, automáticamente dejan de mandarse al cruce. No hay que tocar esas dos funciones.)

- [ ] **Step 3: Verificar typecheck**

Run: `pnpm --filter pase typecheck`
Expected: PASS — sin errores. (Si marca `egresosDevueltos`/`ingresosReales` sin usar, se usan en la Task 3 — completar Task 3 antes de re-correr, o el lint de no-unused se resuelve ahí.)

- [ ] **Step 4: Commit**

```bash
git add packages/pase/src/pages/ConciliacionExtracto.tsx
git commit -m "feat(conciliacion): excluir transferencias devueltas del payload del cruce (Pieza 3)"
```

---

### Task 3: Mostrar las devueltas en la UI (informativo)

**Files:**
- Modify: `packages/pase/src/pages/ConciliacionExtracto.tsx` (panel "antes de cruzar", líneas ~1349-1351)

- [ ] **Step 1: Ajustar el contador de ingresos y agregar la línea de devueltas**

Reemplazar el bloque (actualmente líneas ~1349-1351):

```tsx
              <div style={{ fontSize: 12, color: "var(--muted2)", marginTop: 2 }}>
                ({extractoMovs.length - egresosExtracto.length} ingresos del extracto se ignoran — vienen por otra vía)
              </div>
```

por:

```tsx
              <div style={{ fontSize: 12, color: "var(--muted2)", marginTop: 2 }}>
                ({ingresosReales.length} ingresos del extracto se ignoran — vienen por otra vía)
              </div>
              {egresosDevueltos.length > 0 && (
                <div style={{ fontSize: 12, color: "var(--muted2)", marginTop: 2 }}>
                  ↩️ {egresosDevueltos.length} {egresosDevueltos.length === 1 ? "transferencia devuelta" : "transferencias devueltas"} (enviadas y reintegradas) — se ignoran
                </div>
              )}
```

- [ ] **Step 2: Verificar typecheck + lint**

Run: `pnpm --filter pase typecheck && pnpm --filter pase lint`
Expected: PASS — 0 errors / 0 warnings. (Ya no hay variables sin usar: `egresosDevueltos` e `ingresosReales` se usan acá.)

- [ ] **Step 3: Verificar build**

Run: `pnpm --filter pase build`
Expected: build OK (sin errores de TS/Vite).

- [ ] **Step 4: Commit**

```bash
git add packages/pase/src/pages/ConciliacionExtracto.tsx
git commit -m "feat(conciliacion): mostrar transferencias devueltas como ignoradas en la UI (Pieza 3)"
```

---

### Task 4: Verificación antes/después con datos reales (zona de plata)

**Files:** ninguno (script Node one-off temporal + borrado).

Objetivo: confirmar con el borrador real de Rene Cantina (mayo) que la transferencia Sorribas (ref 158658195423) queda fuera del payload y que SAN JOSE recupera su match. NO se aplica nada a prod — es lectura/cálculo.

- [ ] **Step 1: Bajar credenciales de prod**

Run: `cd /c/Users/lucas/Documents/PASE/packages/pase && npx vercel env pull .env.local.tmp --environment=production`
Expected: archivo `.env.local.tmp` con `POSTGRES_URL_NON_POOLING`.

- [ ] **Step 2: Reproducir la detección sobre el extracto del borrador**

Crear un script Node temporal `packages/pase/_verif_devueltas.mjs` que:
1. Lea `POSTGRES_URL_NON_POOLING` de `.env.local.tmp`.
2. `SELECT data FROM conciliacion_borradores` del local de Rene Cantina (filtrar por el `local_id` que use Rene; si hay varias filas, listar y elegir la de mayo).
3. Extraiga `data.extractoMovs`, aplique la misma lógica de `refsDevueltas` (copiar la función inline en el `.mjs`, no se puede importar TS directo) y print:
   - cantidad total de egresos,
   - cantidad de egresos devueltos (excluidos) + sus `referencia_externa` y montos,
   - confirmar que `158658195423` (Sorribas) está en el set.

```js
import { readFileSync } from "node:fs";
import pg from "pg";

const url = readFileSync(".env.local.tmp", "utf8")
  .split("\n").find(l => l.startsWith("POSTGRES_URL_NON_POOLING="))
  .split("=").slice(1).join("=").trim().replace(/^"|"$/g, "");

function refsDevueltas(movs) {
  const egresoPorRef = new Map();
  for (const m of movs) if (m.monto < 0 && m.referencia_externa) egresoPorRef.set(m.referencia_externa, Math.abs(m.monto));
  const refs = new Set();
  for (const m of movs) {
    if (m.monto > 0 && m.referencia_externa) {
      const e = egresoPorRef.get(m.referencia_externa);
      if (e != null && Math.abs(e - m.monto) < 1) refs.add(m.referencia_externa);
    }
  }
  return refs;
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const { rows } = await client.query("select local_id, data from conciliacion_borradores");
for (const r of rows) {
  const movs = r.data?.extractoMovs || [];
  const refs = refsDevueltas(movs);
  const devueltos = movs.filter(m => m.monto < 0 && m.referencia_externa && refs.has(m.referencia_externa));
  console.log(`local ${r.local_id}: ${movs.filter(m=>m.monto<0).length} egresos, ${devueltos.length} devueltos`);
  for (const d of devueltos) console.log(`   ↩️ ${d.referencia_externa}  ${d.monto}  ${d.fecha}  ${d.descripcion}`);
  if (refs.has("158658195423")) console.log("   ✅ Sorribas 158658195423 detectada como devuelta");
}
await client.end();
```

Run: `node _verif_devueltas.mjs`
Expected: imprime el local de Rene con ≥1 devuelto, y la línea "✅ Sorribas 158658195423 detectada como devuelta". Si Sorribas NO aparece, revisar que el borrador tenga `extractoMovs` con la devolución (monto positivo) — si el extracto subido no incluía la devolución como fila, la Pieza 3 no puede detectarla y hay que revisar el parser (`mpExtractoParser.ts`) antes de seguir.

- [ ] **Step 2b: Confirmar el resultado con Lucas antes de cerrar**

Mostrar a Lucas el output (qué transferencias quedaron como "devueltas" y los montos). Es plata: que confirme que esas son efectivamente devoluciones reales y no pagos legítimos. Esperar OK explícito.

- [ ] **Step 3: Limpieza**

Run: `rm packages/pase/_verif_devueltas.mjs packages/pase/.env.local.tmp`
Expected: ambos archivos borrados (no quedan credenciales ni scripts sueltos en el repo).

- [ ] **Step 4: Push**

```bash
git push
```
Expected: Vercel toma el deploy. Verificar `state=READY` antes de asumir que prod tomó el cambio (regla del límite de 12 functions / deploy ERROR).

---

## Self-Review

**1. Cobertura del spec (Pieza 3 del spec 2026-06-18):**
- "Detectar el par envío + devolución (mismo `referencia_externa`, montos opuestos)" → Task 1 (`refsDevueltas`). ✅
- "sacar el egreso del pool de matching" → Task 2 (`egresosExtracto` excluye devueltas; el payload de `cruzar`/`refrescarCruce` ya usa `egresosExtracto`). ✅
- "marcarlo como devuelta — ignorada (informativo, no es falta ni sobra)" → Task 3 (línea ↩️ en el panel pre-cruce). ✅
- "Requiere que el front (antes de llamar al cruce) vea también los ingresos" → el front ya tiene `extractoMovs` completo (egresos+ingresos); `refsDevueltas` lee ambos. ✅
- Criterio de éxito del spec (caso Sorribas "devuelta — ignorada", SAN JOSE recupera match) → Task 4 lo verifica con datos reales. ✅

**2. Placeholders:** ninguno — cada step tiene código/comando completo. ✅

**3. Consistencia de tipos:** `refsDevueltas(movs: ExtractoMovimiento[]): Set<string>` — misma firma en Task 1 (def), Task 2 (uso `refsDevueltas(extractoMovs)`) y Task 4 (copia inline). `ExtractoMovimiento` se importa de `./mpExtractoParser` (campos `monto:number`, `referencia_externa: string | null`, `fecha`, `tipo`, `descripcion` — verificados). `egresosDevueltos` / `ingresosReales` definidos en Task 2 y usados en Task 3. ✅

## Riesgo principal y mitigación

Si el extracto subido NO incluía la fila de la devolución (solo el egreso), `refsDevueltas` no puede netear y la Pieza 3 no aplica a ese caso → se detecta en Task 4 Step 2 (Sorribas no aparecería). Mitigación: en ese caso, revisar `mpExtractoParser.ts` para confirmar que las devoluciones se parsean como `monto > 0` con su `referencia_externa`, antes de dar la pieza por cerrada.
