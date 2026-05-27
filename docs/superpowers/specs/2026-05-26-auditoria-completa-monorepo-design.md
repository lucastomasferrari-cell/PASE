# Auditoría completa del monorepo PASE — Design

**Fecha:** 2026-05-26
**Pedido:** Lucas Ferrari
**Estado del request:** "Análisis profundo de PASE y COMANDA sin apuro, todo lo que se pueda analizar y evaluar"

## Objetivo

Hacer un análisis técnico completo del monorepo PASE (PASE app + COMANDA + bot IG + admin-console) que identifique bugs latentes, vulnerabilidades de seguridad, problemas de performance, deuda técnica, overengineering y oportunidades de mejora. El output va a permitir priorizar fixes y decidir qué refactors valen la pena.

## Alcance

**Incluido:**
- `packages/pase` — back-office gastronómico en producción (~150K LOC TS+SQL)
- `packages/comanda` — POS WIP (~50K LOC)
- `packages/instagram-bot` — webhook + push notifications (~15 endpoints)
- `packages/admin-console` — superadmin standalone (~10K LOC)
- `packages/pase/supabase/migrations/*.sql` — todo el schema + RPCs
- Workflows GitHub Actions (`.github/workflows/`)

**Excluido (por ahora):**
- `packages/shared` (scaffold vacío)
- `packages/print-agent` / `packages/print-server` (legacy/experimental, sin uso real)
- Tests E2E (suite ya auditada en sprints anteriores)

## Reglas de operación

### Fix automático vs reporte para revisión

**Auto-fix (commit directo a main):**
- Typos en strings/comentarios
- Dead code, imports sin usar
- `console.log` olvidados (no `console.error`/`warn` defensivos)
- Tests E2E desactualizados respecto al código actual
- Bugs mecánicos: `==` donde va `===`, `await` faltante, `let` que podría ser `const`
- `any` reemplazable por tipo concreto sin cambiar contratos
- Comentarios en inglés mezclados con español (estilo del proyecto)

**Reportar (NO auto-fix):**
- Cambios de arquitectura
- Eliminación de abstracciones existentes
- Refactor que toca >1 archivo
- Cambios de schema DB / RPCs nuevas
- Decisiones de UX
- Lógica de negocio
- Cambios que tocan flows financieros

### Severidad

| Símbolo | Nivel | Definición |
|---|---|---|
| 🔴 | Crítico | Puede causar pérdida de plata, leak entre tenants, vulnerabilidad explotable |
| 🟠 | Alto | Bug que rompe flow visible al user, performance >5s en operación normal, datos inconsistentes |
| 🟡 | Medio | Bug en flow secundario, código difícil de mantener, deuda técnica acumulada |
| 🟢 | Bajo | Nice-to-have, naming feo, documentación faltante |

## Estructura de outputs

```
docs/audit-2026-05/
├── INDEX.md                      ← linkea todos los reportes + status
├── FIXES.md                      ← log de auto-fixes commiteados
├── 00-reconocimiento.md          ← Fase 0: mapa de arquitectura
├── 01-bugs-financieros.md        ← Fase 1
├── 02-seguridad-multitenant.md   ← Fase 2
├── 03-performance.md             ← Fase 3
├── 04-frontend-pase.md           ← Fase 4
├── 05-comanda.md                 ← Fase 5
├── 06-bot-ig-admin-console.md    ← Fase 6
├── 07-deuda-overengineering.md   ← Fase 7
└── 08-consolidacion.md           ← Fase 8: meta-reporte ejecutivo
```

## Plan de ejecución (9 fases)

| # | Fase | Foco | Estimado |
|---|------|------|----------|
| 0 | Reconocimiento | Mapa de arquitectura completo del monorepo + métricas | 30 min |
| 1 | 💰 Bugs financieros | RPCs `pagar_*`, `anular_*`, `crear_gasto`, `transferencia_*`, triggers de saldos, conciliación MP | 3-4 h |
| 2 | 🔐 Seguridad multi-tenant | RLS gaps, leaks entre tenants/locales, secrets, auth.uid() checks, override TOTP | 2 h |
| 3 | ⚡ Performance | N+1 queries, falta de filtros fecha, bundle size, lazy loading, índices faltantes | 2 h |
| 4 | 🎨 Frontend PASE | Componentes grandes, race conditions, lógica de UI duplicada, hooks mal usados | 3 h |
| 5 | 📱 COMANDA | POS offline, recetas, KDS, conteo, manager override, marketplace | 4 h |
| 6 | 🤖 Bot IG + admin-console | Webhook hardening, push, sesiones, auth admin | 1-2 h |
| 7 | 🧹 Deuda + overengineering | Abstracciones innecesarias, duplicación PASE↔COMANDA, archivos legacy | 2-3 h |
| 8 | 📊 Consolidación | Meta-reporte ejecutivo con ranking final | 1 h |

**Total estimado:** 20-25 horas de análisis + redacción distribuidas en varias sesiones.

## Modo de ejecución

- **Subagentes**: uso `Explore` para mapeo rápido, `Plan` para fixes complejos, `general-purpose` para análisis multi-archivo. Cuando hay áreas independientes dentro de una fase, dispatch agentes en paralelo.
- **Memoria entre sesiones**: cada fase termina con commit + push del reporte + update INDEX. La próxima sesión retoma leyendo el INDEX.
- **Git**: push directo a `main` para fixes auto (workflow estándar de Lucas). Reportes commiteados como cualquier doc.

## Criterios de éxito

1. **Cobertura**: todos los archivos relevantes de los 4 paquetes scaneados al menos 1 vez.
2. **Accionabilidad**: cada finding tiene ubicación exacta (archivo:línea) + sugerencia de fix.
3. **Priorización**: el reporte final permite a Lucas decidir en <30 min qué encarar primero.
4. **Sin regresiones**: los auto-fixes pasan typecheck + lint + (cuando aplique) tests E2E.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Auto-fix rompe algo en prod | Solo fixes mecánicos sin lógica. Typecheck + lint antes del commit. Si dudo → al reporte, no auto-fix. |
| Reporte gigante e inactuable | Severidad clara + ranking + ejecutivo final. Lucas puede ignorar 🟡 y 🟢. |
| Costo API alto (subagentes en paralelo) | Estimación previa: USD 30-80 total. Si supera, paro y consulto. |
| Falta de contexto entre sesiones | INDEX.md + FIXES.md persisten estado. Cada sesión arranca leyéndolos. |

## Próximo paso

Crear `docs/audit-2026-05/INDEX.md` con estado "en progreso" + arrancar Fase 0 (reconocimiento).
