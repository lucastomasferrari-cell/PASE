# DECISIONES — Activar TypeScript strict en packages/pase (TASK 0.14)

**Fecha:** 2026-04-27
**Branch:** main
**Status:** Diagnóstico terminado. Plan propuesto. Esperando OK de Lucas para PASO 3.

---

## 1. Diagnóstico (PASO 1) — resultado

### Setup actual

`packages/pase/tsconfig.json`:
- `strict: false`
- `noUnusedLocals: false`, `noUnusedParameters: false`
- `allowJs: true`
- referencia a `tsconfig.node.json` (vestigial, causa error TS6306/TS6310 cuando se corre `tsc` sin la config como composite)

`tsconfig.app.json` existe pero parece vestigial — Vite no usa ninguno de los dos para el build (Vite usa esbuild, no tsc).

`packages/comanda/tsconfig.json` y `packages/shared/tsconfig.json` ya tienen `strict: true` + `noUncheckedIndexedAccess: true` + `noUnusedLocals/Parameters: true`.

No hay script `typecheck` en `package.json`. **Conclusión: tsc nunca se corrió en CI/CD para pase**, por eso los errores se acumularon sin detectarse.

### Baseline (strict: false, config actual)

20 errores pre-existentes (bugs reales que no dependen de strict):

| Archivo | Tipo | Detalle |
|---|---|---|
| `src/App.tsx:206` | TS2559 | Layout recibe props que no espera (`user`, `locales`, `localActivo`) |
| `src/lib/supabase.ts:1` | TS2307 | Import desde `https://esm.sh/...` sin tipos (debería usar `@supabase/supabase-js` ya instalado) |
| `src/lib/supabase.ts:4` | TS2339 | `import.meta.env` sin tipos (falta `vite-env.d.ts`) |
| `src/lib/useCategorias.ts:38,74` | TS2741 | Falta property `refresh` en estado retornado |
| `src/main.tsx:3` | TS2882 | `./index.css` sin declaration (falta `vite-env.d.ts`) |
| `src/pages/Compras.tsx:358` | TS2322 | Prop `user` pasada a componente que no la espera |
| `src/pages/ConciliacionMP.tsx:96` | TS2794 | `Promise<>` sin type argument |
| `src/pages/Contador.tsx:58` | TS2322/TS2345 | Recharts `Color` mal tipado |
| `src/pages/Dashboard.tsx:83,90` | TS2365/TS2345 | Operaciones aritméticas con `unknown` |
| `src/pages/Insumos.tsx:36,120` | TS2345/TS2322 | Mismatch number/string |
| `src/pages/LectorFacturasIA.tsx:31,217,370` | TS2339/TS2345/TS2322 | `string \| ArrayBuffer` mal narrowed; mismatch number/string |
| `src/pages/RRHHLegajo.tsx:548,773,825` | TS2552 | **Bug real**: `cuentasUsables` no existe (typo de `cuentasVisibles`) |

**Estos 20 errores hay que arreglarlos sí o sí, sin importar strict.** Tres de ellos (`cuentasUsables`) son bugs que probablemente rompen RRHHLegajo en runtime cuando se llega a esos paths.

### Con strict: true

**854 errores totales** (incluye los 20 baseline).

#### Distribución por código de error

| Código | Cantidad | % | Significado |
|---|---|---|---|
| TS2339 | 453 | 53% | "Property X does not exist on type Y" — **449 son `type 'never'`** (useState arrays sin generic) |
| TS7006 | 256 | 30% | Parameter implicit `any` (callbacks `.map(v => ...)` sin tipo) |
| TS7031 | 47 | 6% | Binding element implicit `any` (destructuring sin tipo) |
| TS7053 | 24 | 3% | Element implicit `any` (acceso por string a `{}`) |
| TS18047 | 22 | 3% | "X is possibly null" |
| TS2698 | 19 | 2% | Spread de no-objeto (`...itemNever`) |
| TS2322 | 9 | 1% | Type not assignable |
| TS2345 | 6 | <1% | Argument type mismatch |
| Otros | 18 | 2% | TS2353, TS18046, TS2552, TS2741, TS2882, etc. |

**Insight clave:** 449 de los 453 TS2339 son del patrón `const [items, setItems] = useState([])` que TypeScript infiere como `never[]`. Cuando se hace `items.map(v => v.fecha)`, falla con "Property 'fecha' does not exist on type 'never'". Encontrados 24 `useState([])`, 15 `useState(null)` y 19 `useState({...})` literales en `src/`. **Tipar correctamente esos ~58 useState hace caer la gran mayoría de errores en cascada** — no son 854 problemas distintos.

#### Distribución por archivo (top 16)

| # | Archivo | Errores |
|---|---|---|
| 1 | `src/pages/ConciliacionMP.tsx` | 158 |
| 2 | `src/pages/Recetas.tsx` | 80 |
| 3 | `src/pages/Remitos.tsx` | 68 |
| 4 | `src/pages/Ventas.tsx` | 64 |
| 5 | `src/pages/RRHH.tsx` | 58 |
| 6 | `src/pages/EERR.tsx` | 46 |
| 7 | `src/pages/RRHHLegajo.tsx` | 44 |
| 8 | `src/pages/Insumos.tsx` | 38 |
| 9 | `src/pages/Contador.tsx` | 38 |
| 10 | `src/pages/Usuarios.tsx` | 36 |
| 11 | `src/pages/LectorFacturasIA.tsx` | 34 |
| 12 | `src/pages/CajaEfectivo.tsx` | 32 |
| 13 | `src/pages/ImportarMaxirest.tsx` | 30 |
| 14 | `src/pages/Dashboard.tsx` | 27 |
| 15 | `src/pages/Config.tsx` | 25 |
| 16 | `src/App.tsx` | 18 |

Cola larga: `Compras.tsx (11)`, `Gastos.tsx (10)`, `Cashflow.tsx (10)`, `Proveedores.tsx (7)`, `Caja.tsx (4)`, `Costos.tsx (3)`, `Login.tsx (2)`, `ListaPrecios.tsx (2)`, `ForcePasswordChange.tsx (2)`, `useCategorias.ts (2)`, `supabase.ts (2)`, `Layout.tsx (2)`, `main.tsx (1)`.

#### Distribución por sección

- `src/pages/`: 829 errores (97%)
- `src/App.tsx`: 18
- `src/lib/`: 4 (supabase + useCategorias)
- `src/components/`: 2 (Layout)
- `src/main.tsx`: 1
- `src/types/`, `src/hooks/`: 0
- `api/` (.js, no entra a tsc): N/A
- `tests/*.spec.ts` (Playwright e2e, fuera de `include: ["src"]`): N/A
- `src/lib/*.test.ts` (vitest): incluidos, no muestran errores

#### Estimación de complejidad

**Trivial (~80%):** anotar un tipo concreto a un `useState` o a un parámetro callback. Una vez tipado el state, decenas de errores derivados desaparecen.

**Medio (~15%):** narrowing de null/undefined (TS18047), tipar respuestas de Supabase (`.from('x').select()` retorna `unknown` sin types generados), unificar shapes de objetos en `useState({...})` con `editar(row)` que recibe distintas formas.

**No trivial (~5%):**
- ConciliacionMP.tsx tiene lógica compleja de matching que mezcla tipos.
- Recharts (`Contador.tsx`, `Dashboard.tsx`) tiene types estrictos para `Color` y `Pie` data.
- LectorFacturasIA.tsx mezcla `string | ArrayBuffer` (FileReader) y necesita narrowing.
- RRHHLegajo.tsx tiene 3 referencias a una variable inexistente (`cuentasUsables`) — bug real, no solo tipo.

---

## 2. Plan de ataque (PASO 2) — propuesto

### Estrategia: gradual con `// @ts-nocheck`

**Por qué gradual y no big-bang:** un commit con 854 errores arreglados es imposible de revisar y de smoke-testear. Lucas necesita probar módulos financieros (Ventas, Caja, ConciliacionMP) por separado tras cada cambio.

**Por qué `@ts-nocheck` y no overrides por archivo:** TypeScript no soporta `strict` por archivo nativamente. La práctica estándar para migrar gradualmente es:
1. Activar strict en el commit inicial.
2. Agregar `// @ts-nocheck` al tope de cada archivo no migrado.
3. En cada commit subsiguiente, quitar `@ts-nocheck` de N archivos y arreglarlos.
4. CI/CD valida `tsc --noEmit` desde el primer commit (gating real).

`@ts-nocheck` es severo (apaga TODO el typechecking del archivo), pero es temporal y se quita archivo por archivo.

**Alternativa descartada:** big-bang en un solo commit. Riesgo demasiado alto para Ventas/Caja/ConciliacionMP. Lucas no podría smoke-testear granularmente.

### Etapas (8 commits)

| # | Commit | Archivos | Errores | Riesgo |
|---|---|---|---|---|
| 1 | `chore(ts): activar strict + foundation types` | tsconfig + types/ + lib/ + App + main + components + 6 páginas chicas | ~30 reales + `@ts-nocheck` en el resto | BAJO |
| 2 | `chore(ts): páginas medianas` | Compras, Cashflow, Gastos, Proveedores, Config, Caja, Costos, ListaPrecios, Login, ForcePasswordChange | 76 | BAJO |
| 3 | `chore(ts): Ventas.tsx strict` | Ventas.tsx (sólo) | 64 | **ALTO** (flow financiero crítico) |
| 4 | `chore(ts): cajas e inventario` | CajaEfectivo, ImportarMaxirest, Insumos | 100 | ALTO (flows de plata + import Maxirest) |
| 5 | `chore(ts): RRHH strict` | RRHH, RRHHLegajo, Usuarios | 138 + bug fix `cuentasUsables` | MEDIO-ALTO |
| 6 | `chore(ts): reportes y dashboards` | Dashboard, Contador, EERR, LectorFacturasIA | 145 | MEDIO (Recharts es delicado) |
| 7 | `chore(ts): recetas y remitos` | Recetas, Remitos | 148 | MEDIO |
| 8 | `chore(ts): ConciliacionMP strict + cleanup` | ConciliacionMP + sincronizar tsconfig.app.json + agregar `typecheck` script + remover `allowJs` si no aplica | 158 + cleanup | **ALTO** (módulo MP delicado) |

### Detalle por etapa

#### Etapa 1 — Foundation (commit 1)

**Objetivos:**
- `packages/pase/tsconfig.json`: `strict: true`, mantener `allowJs: true` por ahora, remover `references` rota.
- Crear `src/vite-env.d.ts` con `/// <reference types="vite/client" />` para fix `import.meta.env` y `./index.css` import.
- Fix `src/lib/supabase.ts`: cambiar import de `https://esm.sh/...` por `@supabase/supabase-js` (ya está en package.json).
- Crear/expandir `src/types/`:
  - `Venta`, `ItemVenta`
  - `Compra`, `ItemCompra`, `MedioPago`
  - `Receta`, `ItemReceta`
  - `Insumo`, `Remito`, `ItemRemito`
  - `MovimientoMP`, `Cierre`, `CajaSaldo`
  - `Local`, `Usuario` (auth)
  - `CategoriaIngreso`, `CategoriaEgreso`
  - Refinar `User`, `Perfil` ya implícitos en App.tsx
- Arreglar `src/App.tsx` (18 errores), `src/components/Layout.tsx` (2), `src/main.tsx` (1), `src/lib/useCategorias.ts` (2 — agregar `refresh` faltante).
- Arreglar páginas chicas que ya están casi limpias: `Login.tsx (2)`, `ListaPrecios.tsx (2)`, `ForcePasswordChange.tsx (2)`, `Costos.tsx (3)`, `Caja.tsx (4)`, `Proveedores.tsx (7)`.
- Agregar `// @ts-nocheck` a los 19 archivos restantes (todos los pages medianos/grandes).
- **Verificación:** `pnpm --filter pase exec tsc --noEmit` → 0 errores. `pnpm --filter pase test` → 152/152. Build OK.

**Riesgo:** BAJO. Casi todo es agregar tipos sin cambiar lógica. La excepción es `src/lib/supabase.ts` (cambiar el import esm.sh por package — Lucas debe smoke-testear que el login y queries básicos funcionan).

#### Etapa 2 — Medianas (commit 2)

Quitar `@ts-nocheck` y arreglar:
- `Compras.tsx` (11), `Cashflow.tsx` (10), `Gastos.tsx` (10), `Config.tsx` (25 — incluye 8 null checks de modal), `Configuracion.tsx`, `Blindaje.tsx`.

**Riesgo:** BAJO. Compras y Gastos ya tienen `parseMonto` integrado y types parciales.

#### Etapa 3 — Ventas (commit 3, dedicado)

`Ventas.tsx` (64 errores). El flow Ventas es crítico (carga turnos, cierres, RPCs `eliminar_venta`/`editar_venta`). Lucas debe smoke-testear:
- Listado de ventas filtrado por fecha/local/turno.
- Crear/editar/eliminar venta.
- Cierre de turno.
- Vista resumen por medio de pago.

**Riesgo:** ALTO. Si fallo el shape de un item, puede romper guardado. Mitigación: tipar contra el schema real de Supabase + comparar con RPC signatures que ya están en uso.

#### Etapa 4 — Cajas e inventario (commit 4)

`CajaEfectivo.tsx (32)`, `ImportarMaxirest.tsx (30)`, `Insumos.tsx (38)`.

**Riesgo:** ALTO. ImportarMaxirest tiene parser CSV reciente (commit 3d19197 arregló duplicados — no romper esa lógica). CajaEfectivo es flow de plata. Smoke test requerido.

#### Etapa 5 — RRHH (commit 5)

`RRHH.tsx (58)`, `RRHHLegajo.tsx (44)`, `Usuarios.tsx (36)`. Incluye fix del bug `cuentasUsables → cuentasVisibles` (3 ocurrencias) — verificar primero si la sustitución 1:1 es correcta o si era una variable diferente.

**Riesgo:** MEDIO-ALTO. `cuentasUsables` puede ser un bug latente que nunca se ejecutó en runtime; cambiarlo activa código previamente inalcanzable.

#### Etapa 6 — Reportes (commit 6)

`Dashboard.tsx (27)`, `Contador.tsx (38)`, `EERR.tsx (46)`, `LectorFacturasIA.tsx (34)`.

**Riesgo:** MEDIO. Recharts (Contador, Dashboard) requiere narrowing cuidadoso de `Color` y `value`. LectorFacturasIA usa `FileReader` (`string | ArrayBuffer`) — narrow con `typeof === 'string'`.

#### Etapa 7 — Recetas y Remitos (commit 7)

`Recetas.tsx (80)`, `Remitos.tsx (68)`. Mismo patrón que Ventas (useState arrays + items), riesgo controlado si se aplica el mismo enfoque.

**Riesgo:** MEDIO.

#### Etapa 8 — ConciliacionMP + cleanup (commit 8)

`ConciliacionMP.tsx (158)` + cleanup final:
- Sincronizar `tsconfig.app.json` con `tsconfig.json` (o consolidar en uno solo).
- Agregar `typecheck` script: `"typecheck": "tsc --noEmit"`.
- Considerar remover `allowJs: true` si ya no hay .js dentro de src/ (verificar).
- Considerar agregar `noUncheckedIndexedAccess: true` para alinear con shared/comanda (puede destapar más errores → si destapa muchos, dejar para una task futura).
- Actualizar CLAUDE.md/README con nota de typecheck.

**Riesgo:** ALTO para ConciliacionMP (módulo MP es central y tiene matching complejo); BAJO para el cleanup.

### Reglas durante la ejecución

- NO usar `any` para apagar errores. Si no hay tipo claro: `unknown` + narrowing, o tipo concreto inferido del schema Supabase.
- NO usar `// @ts-ignore` salvo que sea genuinamente irresoluble (libraries sin types). Documentar cada uso.
- `// @ts-nocheck` permitido **solo** en archivos pendientes de migrar; debe ser removido al finalizar el plan. Etapa 8 debe verificar 0 archivos con `@ts-nocheck`.
- Tests vitest 152/152 después de cada commit. Si rompe un test, arreglar en el mismo commit.
- Después de cada commit: push individual + Lucas smoke-testea el módulo afectado antes de seguir.

### Tiempo estimado

- Etapa 1: 60–90 min (foundation grande, decide la calidad de tipos del resto).
- Etapa 2: 30–45 min.
- Etapa 3 (Ventas): 45–60 min — crítico, ir con cuidado.
- Etapa 4: 60–75 min.
- Etapa 5: 60–75 min — verificar `cuentasUsables` antes.
- Etapa 6: 60 min.
- Etapa 7: 45–60 min.
- Etapa 8 (ConciliacionMP + cleanup): 90–120 min.

**Total: 7–10 horas de trabajo de Claude**, repartido en 3–4 sesiones para que Lucas alcance a smoke-testear entre etapas.

### Decisiones pendientes que necesito que Lucas confirme

1. **¿OK con el enfoque `@ts-nocheck` gradual en 8 commits?** (vs. big-bang en 1 commit, vs. más etapas más chicas).
2. **¿Agrego `noUncheckedIndexedAccess: true` en Etapa 8?** Va a destapar errores adicionales (acceso a arrays sin chequeo de índice). Si no lo agregamos ahora, queda como pase divergente del resto del monorepo.
3. **`cuentasUsables` en RRHHLegajo (3 refs):** ¿es typo seguro de `cuentasVisibles` o quiere que primero busque commits viejos para ver qué era? (lo voy a investigar antes de la etapa 5, sólo flag).
4. **Orden de etapas:** ¿priorizar Ventas/Caja/ConciliacionMP primero (crítico) o dejarlo al final como propuse? Mi propuesta los pone en medio/al final para que el foundation esté firme primero.
