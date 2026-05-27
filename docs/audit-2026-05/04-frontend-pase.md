# Fase 4 — Frontend PASE (consolidado)

**Estado:** ✅ Completa
**Fecha:** 2026-05-27
**Método:** 3 agentes en paralelo (F4A páginas grandes · F4B UX/consistencia · F4C hooks/utils), grep masivo + lectura estática TS.

## 📊 Resumen ejecutivo

**~80 findings totales** en 3 dominios. **11 críticos accionables**.

Sub-reportes:
- [04a-paginas-grandes.md](./04a-paginas-grandes.md) — 33 findings (4 CR + 14 AL)
- [04b-ux-consistencia.md](./04b-ux-consistencia.md) — 16 findings (3 CR + 5 AL)
- [04c-hooks-utils.md](./04c-hooks-utils.md) — 30+ findings (4 CR + altos)

### ⚠️ Hallazgos confirmados

1. **`utils.ts:32` `export const today = new Date()`** — valor frozen al primer import. Una pestaña abierta a las 23:55 AR sigue viendo el día anterior 18+ horas después. **Consumido por 20 archivos** (dashboards + bandeja entrada + filtros de "hoy").
2. **57 `.toISOString().slice(0,10)`** ignoran helper `fmt_dt_ar` — devuelven UTC, no Buenos Aires. `useBandejaEntrada` filtra facturas vencidas contra fecha UTC.
3. **~25 KB de dead code** sin un solo consumidor: `useFinanzas`, `useNegocio`, `caja.service`, `rrhh.service`, `saldoMP` + test. `caja.service.actualizarSaldo` tiene race condition read-then-write marcada como deuda C4-F11.
4. **150 `alert/confirm/prompt`** en producción para flujos de plata (anulaciones, motivos auditoría). En PWA iOS los `confirm()` muestran "pase-yndx.vercel.app dice".
5. **`<Modal>` con 8% adoption** (4 de 51 pages) — 24 archivos dibujan overlay manual con position:fixed inline. 3 patrones coexisten.
6. **`ConciliacionMP.tsx:413-421`** — setInterval(120s) sin cleanup en unmount.
7. **0 useMemo/useCallback** en 6 de 8 páginas grandes (>1k LOC).
8. **227 `<label>` y solo 1 con `htmlFor`** (0.4% a11y).
9. **587 `fontSize:` hardcoded** vs 107 con tokens (83% ignora design system).
10. **24 pages con emojis hardcoded** post-decisión 17-may de usar `Icons.tsx`.

---

## 🎯 Ranking de los 11 críticos

| # | Bug | Sub | Esfuerzo | Impacto |
|---|---|---|---|---|
| 1 | `today` frozen al import — 20 archivos afectados, filtros de "hoy" stale | F4C | 30 min | Bandeja vencidas + dashboards stale después de 24h |
| 2 | 57 `.toISOString().slice(0,10)` UTC vs AR | F4C | 1h migrar | Filtros de fecha desplazados 3-4h |
| 3 | 25 KB dead code (5 archivos sin consumers) | F4C | 5 min | Cleanup + previene revivir caja.service con race condition |
| 4 | `ConciliacionMP.tsx:413` setInterval sin cleanup | F4A | 5 min | Memory leak al navegar mientras sincroniza |
| 5 | `Gastos.tsx:177` useEffect sin guard isMounted + no refresh al cambiar localActivo | F4A | 10 min | Empleados de otros locales mezclados (bug histórico) |
| 6 | `RRHHLegajo.tsx:175` race condition vacTomadas async | F4A | 15 min | Liquidación final calcula total incorrecto si modal abre antes del fetch |
| 7 | `Usuarios.tsx:213` delete+insert permisos sin RPC atómica + sin rollback | F4A | 1h (nueva RPC) | Si insert falla, user queda sin permisos |
| 8 | Sin helper money math + 3 aliases (`fmt_$`/`formatCurrency`/`fmt_money`) | F4C | 2h | Floats acumulan errores; `.toFixed(2)` usado como key de dedup |
| 9 | Sin `logError` backend — 29 `console.error` solo en DevTools | F4C | 1h | Errors en prod invisibles para Lucas |
| 10 | Modal con 8% adoption — 3 patterns + 24 archivos manual | F4B | sprint dedicado | Inconsistencia visual + UX |
| 11 | 150 `alert/confirm/prompt` en flujos de plata | F4B | sprint dedicado | UX horrible en PWA iOS |

### Decisiones pendientes

- ¿Migrar TODOS los `today` callers a `now()` ahora, o solo los que filtran "hoy"?
- Modal pattern (F4B#1): ¿estandarizar en `<Modal>` actual o redesignar más rico?
- Toast vs alert (F4B#2): rampa de migración (4 sprints aprox).
- `Usuarios.tsx` permisos atómicos: ¿hacer RPC `sincronizar_permisos_usuario(p_user_id, p_slugs[])`?

---

## Plan de ataque (este sprint)

**Auto-fixeables ya:**
1. Dead code cleanup (F4C#3): `rm` 5 archivos.
2. Bug TZ #1: `utils.ts` agregar `now()` function + JSDoc deprecando `today`. Migrar `useBandejaEntrada` (que filtra facturas vencidas / MP sin conciliar contra fecha) — el resto migrar gradual.
3. setInterval cleanup ConciliacionMP #4.
4. Gastos useEffect #5 cleanup + refresh trigger.
5. RRHHLegajo vacTomadas race #6: bloquear modal hasta que vacTomadas esté cargado.

**Defer (sprints dedicados):**
- Bug TZ #2: 57 callers — migración gradual page por page.
- Money helper #8: implica decidir Big.js vs custom + migrar 16+8 callers.
- logError backend #9: nuevo endpoint + ErrorBoundary refactor.
- Modal pattern #10: rediseño con focus trap + a11y.
- Toast migration #11: requiere rampa coordinada con cambio de UX.
- Usuarios permisos atómicos #7: RPC nueva + refactor.

---

## Cross-fase

1. **PASE no usa Tailwind** — diseño con CSS custom + variables. Conviene formalizar más componentes en `src/components/ui/` y reducir markup inline.
2. **Adopción C8 (lazy)** está al 97% — bien. Pero falta análoga regla "C12 — usar `<Modal>` en vez de overlay manual" + ESLint rule.
3. **Adopción C6 (debounce)** está 6 de 7 pages — solo `Compras.tsx` pendiente.
4. **0 instancias de `React.memo`** (también F3C) — patrón ausente en todo el monorepo. Ganancia significativa en componentes que reciben props iguales en cada render.

## Para la próxima fase (F5)

F4 atacó PASE. F5 hace lo mismo con COMANDA (que es WIP, esperamos más deuda). Atacar:
- COMANDA páginas grandes (`VentaScreen.tsx` 1378 LOC).
- Sync engine de COMANDA (offline-first IndexedDB + push queue).
- Tests de COMANDA (cobertura, tests faltantes en flujos críticos).
- Servicios `packages/comanda/src/services/*` consistencia.
